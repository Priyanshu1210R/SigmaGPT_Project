import express from "express";
import Thread from "../models/Thread.js";
import Document from "../models/Document.js";
import User from "../models/User.js";
import { streamGeminiResponse, GeminiError } from "../utils/gemini.js";
import { embedQuery } from "../utils/embeddings.js";
import { retrieveRelevantChunks } from "../utils/retrieval.js";
import authMiddleware from "../middlewares/authMiddleware.js";
import { chatLimiter } from "../middlewares/rateLimit.js";

const router = express.Router();
const FREE_LIMIT = 20;
const RAG_TOP_K = 5;

const MAX_MESSAGE_CHARS = 8000;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024; // decoded size
const MAX_HISTORY_MESSAGES = 60; // hard cap on rows fetched; token budget trims further
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);

router.use(authMiddleware);

// ================= GET ALL THREADS (sidebar) =================
router.get("/thread", async (req, res) => {
  try {
    const threads = await Thread.find({ userId: req.user._id }, "threadId title updatedAt")
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    return res.json(threads);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch threads" });
  }
});

// ================= GET SINGLE THREAD =================
router.get("/thread/:threadId", async (req, res) => {
  const { threadId } = req.params;
  try {
    const thread = await Thread.findOne({ threadId, userId: req.user._id }).lean();
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    return res.json(thread);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch thread" });
  }
});

// ================= DELETE THREAD =================
router.delete("/thread/:threadId", async (req, res) => {
  const { threadId } = req.params;
  try {
    const deleted = await Thread.findOneAndDelete({ threadId, userId: req.user._id });
    if (!deleted) return res.status(404).json({ error: "Thread not found" });
    return res.status(200).json({ success: "Thread deleted successfully" });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete thread" });
  }
});

// Parse + validate a data URL. Returns { mimeType, data } or throws a 400-style string.
const parseImage = (image) => {
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(image);
  if (!match) throw "Invalid image format";
  const [, mimeType, data] = match;
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) throw "Unsupported image type (use PNG, JPEG, WebP, or HEIC)";
  if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) throw "Image is too large (max 7MB)";
  return { mimeType, data };
};

// ================= CHAT ROUTE (Server-Sent Events) =================
// Validation, quota and history loading all happen BEFORE we touch the response, so every
// failure up to that point is still a plain JSON error with the right status code — the
// frontend keeps using `response.ok` / `response.json()` for those, unchanged.
//
// Only once we start calling Gemini do we switch to an SSE stream of JSON lines:
//   data: {"type":"token", "text": "..."}                          - one chunk of the reply
//   data: {"type":"done",  "usageCount": n, "isPremium": bool}      - finished + saved
//   data: {"type":"error", "message": "...", "usageCount", "isPremium", "partial"?}
router.post("/chat", chatLimiter, async (req, res) => {
  const { threadId, message, image } = req.body;

  if (typeof threadId !== "string" || !threadId || threadId.length > 100)
    return res.status(400).json({ error: "Invalid threadId" });
  if (message != null && typeof message !== "string")
    return res.status(400).json({ error: "Invalid message" });
  if (image != null && typeof image !== "string")
    return res.status(400).json({ error: "Invalid image" });

  const userMessageText = message?.trim() || "";
  if (!userMessageText && !image) return res.status(400).json({ error: "Missing fields" });
  if (userMessageText.length > MAX_MESSAGE_CHARS)
    return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_CHARS} characters)` });

  let imagePayload = null;
  if (image) {
    try {
      imagePayload = parseImage(image);
    } catch (msg) {
      return res.status(400).json({ error: msg });
    }
  }

  // Reserve one message of quota ATOMICALLY. A single conditional $inc means two parallel
  // requests can no longer both slip under the limit.
  const reserved = await User.findOneAndUpdate(
    { _id: req.user._id, $or: [{ isPremium: true }, { usageCount: { $lt: FREE_LIMIT } }] },
    { $inc: { usageCount: 1 } },
    { new: true, projection: "usageCount isPremium" }
  ).lean();

  if (!reserved) {
    return res.status(403).json({
      error: "FREE_LIMIT_REACHED",
      message: `You've used all ${FREE_LIMIT} free messages. Upgrade to Premium to continue.`,
      usageCount: FREE_LIMIT,
      isPremium: false,
    });
  }

  let usageCount = reserved.usageCount;
  const isPremium = reserved.isPremium;
  let refunded = false;
  const refundQuota = async () => {
    if (refunded) return;
    refunded = true;
    usageCount -= 1;
    await User.updateOne({ _id: req.user._id }, { $inc: { usageCount: -1 } }).catch((err) =>
      console.error("Failed to refund usage:", err)
    );
  };

  // Fetch only the last N messages, and only role+content (never old base64 images).
  let history = [];
  try {
    const [existing] = await Thread.aggregate([
      { $match: { threadId, userId: req.user._id } },
      {
        $project: {
          recent: {
            $map: {
              input: { $slice: ["$messages", -MAX_HISTORY_MESSAGES] },
              as: "m",
              in: { role: "$$m.role", content: "$$m.content" },
            },
          },
        },
      },
    ]);
    history = existing?.recent || [];
  } catch (err) {
    console.error(err);
    await refundQuota();
    return res.status(500).json({ error: "Something went wrong" });
  }

  // ---------- RAG: retrieve relevant chunks from any documents attached to this thread ----------
  // Skipped entirely (no embedding-API cost) if the thread has no successfully-indexed documents.
  let retrievedChunks = [];
  const hasDocs = await Document.exists({ threadId, userId: req.user._id, status: "ready" });
  if (hasDocs && userMessageText) {
    try {
      const queryEmbedding = await embedQuery(userMessageText);
      retrievedChunks = await retrieveRelevantChunks({
        threadId,
        userId: req.user._id,
        queryEmbedding,
        topK: RAG_TOP_K,
      });
      console.log(`[rag] thread ${threadId}: retrieved ${retrievedChunks.length} chunk(s)`);
    } catch (err) {
      // Retrieval failing shouldn't block the chat entirely — fall back to answering
      // without document context rather than erroring the whole request.
      console.error("RAG retrieval failed, continuing without it:", err?.message || err);
      retrievedChunks = [];
    }
  }

  // ---------- switch to SSE ----------
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // don't let nginx-style proxies buffer the stream
  });
  res.flushHeaders();

  const send = (payload) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Sent once, before the token stream: lets the frontend render a "Sources" list right away,
  // which the model's inline [1] [2] markers (see SYSTEM_INSTRUCTION) point back into.
  if (retrievedChunks.length) {
    send({
      type: "citations",
      citations: retrievedChunks.map(({ documentId, fileName, chunkIndex, text }) => ({
        documentId,
        fileName,
        chunkIndex,
        text,
      })),
    });
  }

  // Stop paying Gemini for tokens nobody will read if the client disconnects mid-stream.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  let fullText = "";
  let streamErr = null;
  try {
    for await (const token of streamGeminiResponse(userMessageText, imagePayload, history, controller.signal, retrievedChunks)) {
      fullText += token;
      send({ type: "token", text: token });
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      streamErr = err instanceof GeminiError ? err : new GeminiError("Something went wrong", 500);
    }
  }

  if (controller.signal.aborted) return res.end(); // client is gone; nothing left to send

  // Nothing usable was generated -> refund, don't save an empty turn.
  if (!fullText) {
    await refundQuota();
    send({
      type: "error",
      message: streamErr?.message || "The model returned no response. Try rephrasing.",
      usageCount,
      isPremium,
    });
    return res.end();
  }

  // Save whatever we got — including a partial reply if the stream broke mid-way,
  // since a half-answer the user already read is more useful than losing it.
  try {
    const now = new Date();
    await Thread.updateOne(
      { threadId, userId: req.user._id },
      {
        $push: {
          messages: {
            $each: [
              { role: "user", content: userMessageText, image: image || null, timestamp: now },
              {
                role: "model",
                content: fullText,
                timestamp: new Date(),
                citations: retrievedChunks.length ? retrievedChunks : undefined,
              },
            ],
          },
        },
        $set: { updatedAt: now },
        $setOnInsert: { title: (userMessageText || "Image scan").substring(0, 50), createdAt: now },
      },
      { upsert: true }
    );

    // Thread may already exist (created by a document upload) with the placeholder title.
    await Thread.updateOne(
      { threadId, userId: req.user._id, title: "New Chat" },
      { $set: { title: (userMessageText || "Image scan").substring(0, 50) } }
    );
  } catch (err) {
    console.error("Failed to save thread:", err);
    send({ type: "error", message: "The reply was generated but could not be saved.", usageCount, isPremium });
    return res.end();
  }

  if (streamErr) {
    send({ type: "error", message: "The response was interrupted. Partial reply saved.", partial: true, usageCount, isPremium });
  } else {
    send({ type: "done", usageCount, isPremium });
  }
  return res.end();
});

export default router;
