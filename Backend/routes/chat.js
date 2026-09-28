import express from "express";
import Thread from "../models/Thread.js";
import User from "../models/User.js";
import getGeminiAPIResponse, { GeminiError } from "../utils/gemini.js";
import authMiddleware from "../middlewares/authMiddleware.js";
import { chatLimiter } from "../middlewares/rateLimit.js";

const router = express.Router();
const FREE_LIMIT = 20;

const MAX_MESSAGE_CHARS = 8000;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024; // decoded size
const MAX_HISTORY_MESSAGES = 60; // hard cap on rows fetched; token budget trims further
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);

router.use(authMiddleware);

// ================= GET ALL THREADS (sidebar) =================
// Only the fields the sidebar needs. Previously this loaded every message
// (including base64 images) of every thread just to read the titles.
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

// ================= CHAT ROUTE =================
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

  // Reserve one message of quota ATOMICALLY. The old read-check-then-increment let
  // parallel requests blow past the free limit.
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

  try {
    // Fetch only the last N messages, and only role+content (never old base64 images).
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

    const assistantReply = await getGeminiAPIResponse(
      userMessageText,
      imagePayload,
      existing?.recent || []
    );

    // One atomic upsert+push instead of load-modify-save of the whole document.
    const now = new Date();
    await Thread.updateOne(
      { threadId, userId: req.user._id },
      {
        $push: {
          messages: {
            $each: [
              { role: "user", content: userMessageText, image: image || null, timestamp: now },
              { role: "model", content: assistantReply, timestamp: new Date() },
            ],
          },
        },
        $set: { updatedAt: now },
        $setOnInsert: { title: (userMessageText || "Image scan").substring(0, 50), createdAt: now },
      },
      { upsert: true }
    );

    return res.json({
      reply: assistantReply,
      usageCount: reserved.usageCount,
      isPremium: reserved.isPremium,
    });
  } catch (err) {
    // Failed call -> give the reserved message back.
    await User.updateOne({ _id: req.user._id }, { $inc: { usageCount: -1 } }).catch(() => {});

    if (err instanceof GeminiError) {
      return res.status(err.status === 429 ? 503 : err.status).json({ error: err.message });
    }
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
});

export default router;
