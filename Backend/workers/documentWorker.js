import Document from "../models/Document.js";
import DocumentChunk from "../models/DocumentChunk.js";
import UploadJob from "../models/UploadJob.js";
import { extractText, UnsupportedFileError } from "../utils/textExtractor.js";
import { chunkText } from "../utils/chunker.js";
import { embedChunks } from "../utils/embeddings.js";
import { GeminiError } from "../utils/gemini.js";

// ---------------------------------------------------------------------------
// Background document indexing: extract -> chunk -> embed -> save.
//
// Jobs live in the UploadJob collection (MongoDB). Workers claim them with an
// atomic findOneAndUpdate, so any number of workers/instances can run safely.
// A claimed job holds a *lease*; if the process dies mid-job the lease expires
// and another worker picks it up. Failures retry with exponential backoff.
// ---------------------------------------------------------------------------

const LEASE_MS = 5 * 60 * 1000; // renewed by a heartbeat while a job runs
const RETRY_BASE_MS = 15 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

const defaultDeps = { Document, DocumentChunk, UploadJob, extractText, chunkText, embedChunks };

export const backoffMs = (attempt) => Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);

// Bad input never gets better on retry; everything else (rate limits, 5xx, DB blips) might.
export const isRetryable = (err) => !(err instanceof UnsupportedFileError);

export const userFacingMessage = (err) =>
  err instanceof UnsupportedFileError || err instanceof GeminiError ? err.message : "Failed to process document.";

/** Atomically take the next runnable job (queued & due, or processing with an expired lease). */
export async function claimNextJob({ UploadJob: Jobs = UploadJob, now = new Date() } = {}) {
  return Jobs.findOneAndUpdate(
    {
      $or: [
        { status: "queued", runAfter: { $lte: now } },
        { status: "processing", leaseExpiresAt: { $lt: now } }, // orphaned by a crash/redeploy
      ],
    },
    { $set: { status: "processing", leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: "after" }
  ).select("+fileData");
}

/**
 * Run one claimed job to completion. Never throws — outcomes are recorded on the
 * Document (what the client polls) and the UploadJob (the queue's own bookkeeping).
 */
export async function processJob(job, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const documentId = job.documentId;

  const setDoc = (fields) => d.Document.updateOne({ _id: documentId }, { $set: fields });
  const finishJob = (fields) =>
    d.UploadJob.updateOne({ _id: job._id }, { $set: { finishedAt: new Date(), ...fields }, $unset: { fileData: 1 } });
  const removeChunks = () => d.DocumentChunk.deleteMany({ documentId });

  // Keeps the lease alive during long steps (a big PDF parse, slow embedding calls).
  const heartbeat = setInterval(() => {
    d.UploadJob.updateOne(
      { _id: job._id, status: "processing" },
      { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } }
    ).catch(() => {});
  }, LEASE_MS / 3);
  heartbeat.unref?.();

  try {
    // Crash-loop guard: a job that keeps killing its worker (e.g. OOM on a nasty PDF) stops here
    // instead of being re-claimed forever.
    if (job.attempts > job.maxAttempts) {
      throw new UnsupportedFileError("Processing repeatedly failed or timed out.");
    }

    // Document may have been deleted while it sat in the queue.
    if (!(await d.Document.exists({ _id: documentId }))) {
      await d.UploadJob.deleteOne({ _id: job._id });
      return { outcome: "skipped" };
    }

    await setDoc({ status: "processing", stage: "Reading file", progress: 5, error: null });
    const text = await d.extractText(job.fileData, job.mimeType);
    const chunks = d.chunkText(text);
    if (chunks.length === 0) throw new UnsupportedFileError("Document contained no usable text.");

    await setDoc({ stage: "Embedding", progress: 10 });
    const vectors = await d.embedChunks(chunks, {
      onProgress: (done, total) => setDoc({ progress: 10 + Math.round((80 * done) / total) }),
    });

    await setDoc({ stage: "Saving", progress: 92 });
    const doc = await d.Document.findById(documentId, "fileName userId threadId").lean();
    if (!doc) {
      await d.UploadJob.deleteOne({ _id: job._id });
      return { outcome: "skipped" };
    }

    // Idempotent: a retry after a partial insert must not leave duplicate chunks behind.
    await removeChunks();
    await d.DocumentChunk.insertMany(
      chunks.map((chunk, i) => ({
        documentId,
        userId: doc.userId,
        threadId: doc.threadId,
        fileName: doc.fileName,
        chunkIndex: i,
        text: chunk,
        embedding: vectors[i],
      }))
    );

    const res = await setDoc({ status: "ready", stage: "Ready", progress: 100, chunkCount: chunks.length, error: null });
    if (res.matchedCount === 0) {
      // Deleted while we were saving — don't leave orphaned chunks that retrieval could still hit.
      await removeChunks();
      await d.UploadJob.deleteOne({ _id: job._id });
      return { outcome: "skipped" };
    }

    await finishJob({ status: "done", lastError: null });
    return { outcome: "done", chunkCount: chunks.length };
  } catch (err) {
    console.error(`Document job ${job._id} failed (attempt ${job.attempts}/${job.maxAttempts}):`, err?.message || err);
    const message = userFacingMessage(err);

    try {
      if (isRetryable(err) && job.attempts < job.maxAttempts) {
        const delay = backoffMs(job.attempts);
        await d.UploadJob.updateOne(
          { _id: job._id },
          { $set: { status: "queued", runAfter: new Date(Date.now() + delay), leaseExpiresAt: null, lastError: message } }
        );
        await setDoc({
          status: "queued",
          stage: `Retrying (attempt ${job.attempts + 1}/${job.maxAttempts})`,
          progress: 0,
        });
        return { outcome: "retry", delay };
      }

      await removeChunks(); // drop any partial results
      await setDoc({ status: "failed", stage: "Failed", error: message });
      await finishJob({ status: "failed", lastError: message });
      return { outcome: "failed" };
    } catch (bookkeepingErr) {
      // DB is unreachable. Leave the job as-is: its lease will expire and it'll be re-claimed.
      console.error("Could not record job outcome:", bookkeepingErr);
      return { outcome: "unrecorded" };
    }
  } finally {
    clearInterval(heartbeat);
  }
}

// ---------------------------------------------------------------------------

let kick = () => {};
/** Nudge the in-process worker so a freshly queued job starts immediately instead of at the next poll. */
export const wakeWorker = () => kick();

/**
 * Start polling for jobs. Returns { stop } — stop() halts claiming and waits
 * (up to `timeoutMs`) for in-flight jobs; anything unfinished is recovered via lease expiry.
 */
export function startDocumentWorker({
  concurrency = Number(process.env.DOC_WORKER_CONCURRENCY) || 2,
  pollMs = Number(process.env.DOC_WORKER_POLL_MS) || 3000,
} = {}) {
  let stopped = false;
  let active = 0;
  let timer = null;
  let ticking = false;

  const schedule = (ms) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  };

  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      while (!stopped && active < concurrency) {
        const job = await claimNextJob();
        if (!job) break;
        active++;
        processJob(job)
          .catch((e) => console.error("Unexpected worker error:", e))
          .finally(() => {
            active--;
            schedule(0); // a slot freed up — look for more work right away
          });
      }
    } catch (err) {
      console.error("Job claim failed:", err?.message || err);
    } finally {
      ticking = false;
      schedule(pollMs);
    }
  }

  kick = () => schedule(0);
  schedule(0);
  console.log(`📥 Document worker started (concurrency ${concurrency}, poll ${pollMs}ms)`);

  return {
    async stop(timeoutMs = 10_000) {
      stopped = true;
      clearTimeout(timer);
      kick = () => {};
      const deadline = Date.now() + timeoutMs;
      while (active > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    },
  };
}
