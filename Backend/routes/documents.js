import express from "express";
import multer from "multer";
import mongoose from "mongoose";
import Document from "../models/Document.js";
import DocumentChunk from "../models/DocumentChunk.js";
import Thread from "../models/Thread.js";
import authMiddleware from "../middlewares/authMiddleware.js";
import { uploadLimiter } from "../middlewares/rateLimit.js";
import { extractText, isSupportedMimeType, UnsupportedFileError } from "../utils/textExtractor.js";
import { chunkText } from "../utils/chunker.js";
import { embedChunks } from "../utils/embeddings.js";
import { GeminiError } from "../utils/gemini.js";

const router = express.Router();
router.use(authMiddleware);

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB
const MAX_DOCS_PER_THREAD = 20;

const upload = multer({
  storage: multer.memoryStorage(), // small files, short-lived — no need to touch disk
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

// ================= LIST DOCUMENTS FOR A THREAD =================
router.get("/documents/:threadId", async (req, res) => {
  try {
    const docs = await Document.find(
      { threadId: req.params.threadId, userId: req.user._id },
      "fileName mimeType sizeBytes status chunkCount error createdAt"
    )
      .sort({ createdAt: -1 })
      .lean();
    return res.json(docs);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch documents" });
  }
});

// ================= UPLOAD + INDEX A DOCUMENT =================
// Synchronous for simplicity (fine for portfolio-scale files/traffic): extract -> chunk -> embed -> save,
// then respond. A production version would enqueue this (e.g. BullMQ) and let the client poll/subscribe
// for status, so a slow embedding call can't hold an HTTP request open for tens of seconds.
router.post("/documents/:threadId/upload", uploadLimiter, upload.single("file"), async (req, res) => {
  const { threadId } = req.params;
  const file = req.file;

  if (!file) return res.status(400).json({ error: "No file uploaded (expected field name 'file')" });
  if (!isSupportedMimeType(file.mimetype)) {
    return res.status(400).json({ error: "Unsupported file type. Upload a PDF, .txt, or .md file." });
  }

  // Documents attach to an existing thread (so retrieval can be scoped + access-controlled by threadId).
  const thread = await Thread.exists({ threadId, userId: req.user._id });
  if (!thread) return res.status(404).json({ error: "Thread not found" });

  const existingCount = await Document.countDocuments({ threadId, userId: req.user._id });
  if (existingCount >= MAX_DOCS_PER_THREAD) {
    return res.status(400).json({ error: `Limit of ${MAX_DOCS_PER_THREAD} documents per chat reached.` });
  }

  const doc = await Document.create({
    userId: req.user._id,
    threadId,
    fileName: file.originalname.slice(0, 200),
    mimeType: file.mimetype,
    sizeBytes: file.size,
    status: "processing",
  });

  try {
    const text = await extractText(file.buffer, file.mimetype);
    const chunks = chunkText(text);
    if (chunks.length === 0) throw new UnsupportedFileError("Document contained no usable text.");

    const vectors = await embedChunks(chunks);

    await DocumentChunk.insertMany(
      chunks.map((text, i) => ({
        documentId: doc._id,
        userId: req.user._id,
        threadId,
        fileName: doc.fileName,
        chunkIndex: i,
        text,
        embedding: vectors[i],
      }))
    );

    doc.status = "ready";
    doc.chunkCount = chunks.length;
    await doc.save();

    return res.status(201).json({
      id: doc._id,
      fileName: doc.fileName,
      status: doc.status,
      chunkCount: doc.chunkCount,
    });
  } catch (err) {
    const message =
      err instanceof UnsupportedFileError
        ? err.message
        : err instanceof GeminiError
        ? err.message
        : "Failed to process document.";
    console.error("Document processing failed:", err);
    doc.status = "failed";
    doc.error = message;
    await doc.save();
    return res.status(err instanceof UnsupportedFileError ? 400 : 500).json({ error: message });
  }
});

// ================= DELETE A DOCUMENT =================
router.delete("/documents/:threadId/:documentId", async (req, res) => {
  const { threadId, documentId } = req.params;
  if (!mongoose.isValidObjectId(documentId)) return res.status(400).json({ error: "Invalid document id" });

  try {
    const doc = await Document.findOneAndDelete({ _id: documentId, threadId, userId: req.user._id });
    if (!doc) return res.status(404).json({ error: "Document not found" });
    await DocumentChunk.deleteMany({ documentId });
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
