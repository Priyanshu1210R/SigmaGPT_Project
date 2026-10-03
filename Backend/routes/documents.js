import express from "express";
import multer from "multer";
import mongoose from "mongoose";
import Document from "../models/Document.js";
import DocumentChunk from "../models/DocumentChunk.js";
import Thread from "../models/Thread.js";
import authMiddleware from "../middlewares/authMiddleware.js";
import { uploadLimiter } from "../middlewares/rateLimit.js";
import UploadJob from "../models/UploadJob.js";
import { isSupportedMimeType } from "../utils/textExtractor.js";
import { wakeWorker } from "../workers/documentWorker.js";

const router = express.Router();
router.use(authMiddleware);

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB
const MAX_DOCS_PER_THREAD = 20;
const MAX_ACTIVE_JOBS_PER_USER = 5; // queued + processing; stops one user flooding the queue

const upload = multer({
  storage: multer.memoryStorage(), // small files, short-lived — no need to touch disk
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

// ================= LIST DOCUMENTS FOR A THREAD =================
router.get("/documents/:threadId", async (req, res) => {
  try {
    const docs = await Document.find(
      { threadId: req.params.threadId, userId: req.user._id },
      "fileName mimeType sizeBytes status stage progress chunkCount error createdAt"
    )
      .sort({ createdAt: -1 })
      .lean();
    return res.json(docs);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch documents" });
  }
});

// ================= POLL ONE DOCUMENT'S INDEXING STATUS =================
// Cheap single-document status check for clients waiting on a background upload.
// status: queued | processing | ready | failed (stage/progress give finer detail).
router.get("/documents/:threadId/:documentId/status", async (req, res) => {
  const { threadId, documentId } = req.params;
  if (!mongoose.isValidObjectId(documentId)) return res.status(400).json({ error: "Invalid document id" });

  try {
    const doc = await Document.findOne(
      { _id: documentId, threadId, userId: req.user._id },
      "fileName status stage progress chunkCount error"
    ).lean();
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const done = doc.status === "ready" || doc.status === "failed";
    res.set("Cache-Control", "no-store");
    return res.json({
      id: doc._id,
      fileName: doc.fileName,
      status: doc.status,
      stage: doc.stage,
      progress: doc.progress,
      chunkCount: doc.chunkCount,
      error: doc.error,
      done, // true once there's nothing left to wait for
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch document status" });
  }
});

// ================= UPLOAD A DOCUMENT (indexed in the background) =================
// Validates the file, stores it durably, queues an indexing job and returns 202 immediately.
// A background worker (workers/documentWorker.js) does extract -> chunk -> embed -> save;
// clients poll GET /documents/:threadId/:documentId/status (or the list endpoint) until
// status is "ready" or "failed".
router.post("/documents/:threadId/upload", uploadLimiter, upload.single("file"), async (req, res) => {
  const { threadId } = req.params;
  const file = req.file;

  if (!file) return res.status(400).json({ error: "No file uploaded (expected field name 'file')" });
  if (!isSupportedMimeType(file.mimetype)) {
    return res.status(400).json({ error: "Unsupported file type. Upload a PDF, .txt, or .md file." });
  }

  try {
    // Documents attach to an existing thread (so retrieval can be scoped + access-controlled by threadId).
    // The client generates threadId (uuid) for a brand-new chat, and the Thread is only persisted on the
    // first message. Create it here if the user uploads a document before sending anything.
    // Upsert is scoped to (userId, threadId), so it can't touch another user's thread.
    try {
      await Thread.updateOne(
        { threadId, userId: req.user._id },
        { $setOnInsert: { title: "New Chat", messages: [], createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (err) {
      console.error("Thread upsert failed:", err);
      return res.status(500).json({ error: "Could not prepare chat for upload" });
    }

    const existingCount = await Document.countDocuments({ threadId, userId: req.user._id });
    if (existingCount >= MAX_DOCS_PER_THREAD) {
      return res.status(400).json({ error: `Limit of ${MAX_DOCS_PER_THREAD} documents per chat reached.` });
    }

    const activeJobs = await UploadJob.countDocuments({
      userId: req.user._id,
      status: { $in: ["queued", "processing"] },
    });
    if (activeJobs >= MAX_ACTIVE_JOBS_PER_USER) {
      return res.status(429).json({
        error: "RATE_LIMITED",
        message: "You already have several documents being processed. Wait for them to finish, then try again.",
      });
    }

    const doc = await Document.create({
      userId: req.user._id,
      threadId,
      fileName: file.originalname.slice(0, 200),
      mimeType: file.mimetype,
      sizeBytes: file.size,
      status: "queued",
      stage: "Queued",
      progress: 0,
    });

    try {
      await UploadJob.create({
        documentId: doc._id,
        userId: req.user._id,
        threadId,
        mimeType: file.mimetype,
        fileData: file.buffer,
      });
    } catch (err) {
      // Without a job the document would sit "queued" forever — roll it back.
      await Document.deleteOne({ _id: doc._id }).catch(() => {});
      throw err;
    }

    wakeWorker(); // start right away if a worker runs in this process; otherwise it's picked up on its next poll

    return res.status(202).json({
      id: doc._id,
      fileName: doc.fileName,
      status: doc.status,
      stage: doc.stage,
      progress: doc.progress,
      statusUrl: `/api/documents/${threadId}/${doc._id}/status`,
    });
  } catch (err) {
    console.error("Document upload failed:", err);
    return res.status(500).json({ error: "Could not queue document for processing" });
  }
});

// ================= DELETE A DOCUMENT =================
router.delete("/documents/:threadId/:documentId", async (req, res) => {
  const { threadId, documentId } = req.params;
  if (!mongoose.isValidObjectId(documentId)) return res.status(400).json({ error: "Invalid document id" });

  try {
    const doc = await Document.findOneAndDelete({ _id: documentId, threadId, userId: req.user._id });
    if (!doc) return res.status(404).json({ error: "Document not found" });
    // Also cancel any pending job and drop its stored file. If a worker is mid-flight it notices the
    // missing document and cleans up its own chunks instead of saving them.
    await Promise.all([UploadJob.deleteMany({ documentId }), DocumentChunk.deleteMany({ documentId })]);
    return res.json({ success: "Document deleted" });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete document" });
  }
});

// Multer errors (e.g. file too large) land here, not in the route handler.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE" ? `File is too large (max ${MAX_FILE_BYTES / (1024 * 1024)}MB)` : err.message;
    return res.status(400).json({ error: message });
  }
  console.error(err);
  return res.status(500).json({ error: "Upload failed" });
});

export default router;
