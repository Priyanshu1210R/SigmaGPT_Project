import test from "node:test";
import assert from "node:assert/strict";
import { processJob, claimNextJob, backoffMs, isRetryable } from "../workers/documentWorker.js";
import { UnsupportedFileError } from "../utils/textExtractor.js";
import { GeminiError } from "../utils/gemini.js";

// Minimal in-memory stand-ins for the Mongoose models — enough to exercise the worker's logic
// (state transitions, retries, delete-during-processing) without a database.
function makeEnv({ docExists = true, deleteDuringEmbed = false } = {}) {
  const state = {
    doc: docExists ? { _id: "d1", fileName: "a.txt", userId: "u1", threadId: "t1", status: "queued" } : null,
    chunks: [],
    job: null,
    chunkDeleteCalls: 0,
  };
  const deps = {
    Document: {
      exists: async () => (state.doc ? { _id: "d1" } : null),
      updateOne: async (_f, update) => {
        if (!state.doc) return { matchedCount: 0 };
        Object.assign(state.doc, update.$set);
        return { matchedCount: 1 };
      },
      findById: () => ({ lean: async () => (state.doc ? { ...state.doc } : null) }),
    },
    DocumentChunk: {
      deleteMany: async () => {
        state.chunkDeleteCalls++;
        state.chunks = [];
      },
      insertMany: async (rows) => void state.chunks.push(...rows),
    },
    UploadJob: {
      updateOne: async (_f, update) => {
        if (update.$set) Object.assign(state.job, update.$set);
        if (update.$unset) for (const k of Object.keys(update.$unset)) delete state.job[k];
      },
      deleteOne: async () => void (state.job = { ...state.job, deleted: true }),
    },
    extractText: async () => "hello world",
    chunkText: () => ["chunk one", "chunk two"],
    embedChunks: async (chunks, { onProgress } = {}) => {
      await onProgress?.(chunks.length, chunks.length);
      if (deleteDuringEmbed) state.doc = null;
      return chunks.map(() => [0.1, 0.2]);
    },
  };
  const newJob = (over = {}) => {
    state.job = {
      _id: "j1", documentId: "d1", mimeType: "text/plain", fileData: Buffer.from("x"),
      status: "processing", attempts: 1, maxAttempts: 3, ...over,
    };
    return state.job;
  };
  return { state, deps, newJob };
}

test("happy path: chunks saved, document ready, job done and file bytes dropped", async () => {
  const { state, deps, newJob } = makeEnv();
  const res = await processJob(newJob(), deps);
  assert.equal(res.outcome, "done");
  assert.equal(state.doc.status, "ready");
  assert.equal(state.doc.progress, 100);
  assert.equal(state.doc.chunkCount, 2);
  assert.equal(state.chunks.length, 2);
  assert.equal(state.chunks[1].chunkIndex, 1);
  assert.equal(state.job.status, "done");
  assert.equal("fileData" in state.job, false);
});

test("unsupported/empty document fails immediately with a user-facing message (no retry)", async () => {
  const { state, deps, newJob } = makeEnv();
  deps.extractText = async () => { throw new UnsupportedFileError("No extractable text found."); };
  const res = await processJob(newJob(), deps);
  assert.equal(res.outcome, "failed");
  assert.equal(state.doc.status, "failed");
  assert.equal(state.doc.error, "No extractable text found.");
  assert.equal(state.job.status, "failed");
});

test("transient embedding error re-queues with backoff while attempts remain", async () => {
  const { state, deps, newJob } = makeEnv();
  deps.embedChunks = async () => { throw new GeminiError("busy", 429); };
  const before = Date.now();
  const res = await processJob(newJob({ attempts: 1 }), deps);
  assert.equal(res.outcome, "retry");
  assert.equal(state.job.status, "queued");
  assert.ok(state.job.runAfter.getTime() >= before + backoffMs(1) - 5);
  assert.equal(state.doc.status, "queued");
  assert.match(state.doc.stage, /Retrying/);
});

test("transient error on the final attempt marks the document failed and cleans partial chunks", async () => {
  const { state, deps, newJob } = makeEnv();
  deps.embedChunks = async () => { throw new GeminiError("The embedding service is busy. Try again shortly.", 429); };
  const res = await processJob(newJob({ attempts: 3 }), deps);
  assert.equal(res.outcome, "failed");
  assert.equal(state.doc.status, "failed");
  assert.match(state.doc.error, /busy/);
  assert.ok(state.chunkDeleteCalls >= 1);
});

test("unexpected errors are retried but never leak internals to the user", async () => {
  const { state, deps, newJob } = makeEnv();
  deps.chunkText = () => { throw new Error("mongodb://secret@host exploded"); };
  await processJob(newJob({ attempts: 3 }), deps);
  assert.equal(state.doc.error, "Failed to process document.");
});

test("document deleted while queued: job is dropped, nothing indexed", async () => {
  const { state, deps, newJob } = makeEnv({ docExists: false });
  const res = await processJob(newJob(), deps);
  assert.equal(res.outcome, "skipped");
  assert.equal(state.chunks.length, 0);
  assert.equal(state.job.deleted, true);
});

test("document deleted mid-embedding: no orphaned chunks are saved", async () => {
  const { state, deps, newJob } = makeEnv({ deleteDuringEmbed: true });
  const res = await processJob(newJob(), deps);
  assert.equal(res.outcome, "skipped");
  assert.equal(state.chunks.length, 0);
});

test("crash-loop guard: a job claimed more than maxAttempts times is failed, not run again", async () => {
  const { state, deps, newJob } = makeEnv();
  let extracted = false;
  deps.extractText = async () => { extracted = true; return "x"; };
  const res = await processJob(newJob({ attempts: 4, maxAttempts: 3 }), deps);
  assert.equal(res.outcome, "failed");
  assert.equal(extracted, false);
  assert.match(state.doc.error, /repeatedly failed/);
});

test("retry after partial insert is idempotent (old chunks cleared before insert)", async () => {
  const { state, deps, newJob } = makeEnv();
  state.chunks.push({ stale: true });
  await processJob(newJob(), deps);
  assert.equal(state.chunks.some((c) => c.stale), false);
  assert.equal(state.chunks.length, 2);
});

test("claim query targets due queued jobs and expired leases, oldest first", async () => {
  let captured;
  const fakeJobs = {
    findOneAndUpdate: (filter, update, opts) => {
      captured = { filter, update, opts };
      return { select: (s) => ({ selected: s }) };
    },
  };
  const now = new Date("2026-01-01T00:00:00Z");
  const result = await claimNextJob({ UploadJob: fakeJobs, now });
  assert.deepEqual(captured.filter.$or[0], { status: "queued", runAfter: { $lte: now } });
  assert.deepEqual(captured.filter.$or[1], { status: "processing", leaseExpiresAt: { $lt: now } });
  assert.equal(captured.update.$set.status, "processing");
  assert.equal(captured.update.$inc.attempts, 1);
  assert.deepEqual(captured.opts.sort, { createdAt: 1 });
  assert.equal(result.selected, "+fileData");
});

test("backoff grows exponentially and caps; only bad-input errors skip retry", () => {
  assert.ok(backoffMs(2) === backoffMs(1) * 2);
  assert.ok(backoffMs(50) <= 5 * 60 * 1000);
  assert.equal(isRetryable(new UnsupportedFileError("x")), false);
  assert.equal(isRetryable(new GeminiError("x", 429)), true);
  assert.equal(isRetryable(new Error("db blip")), true);
});
