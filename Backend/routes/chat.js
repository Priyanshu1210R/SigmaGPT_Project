import express from "express";
import Thread from "../models/Thread.js";
import User from "../models/User.js";
import getGeminiAPIResponse from "../utils/gemini.js";
import authMiddleware from "../middlewares/authMiddleware.js";

const router = express.Router();
const FREE_LIMIT = 20;

router.use(authMiddleware);

// ================= GET ALL THREADS =================
router.get("/thread", async (req, res) => {
  try {
    const threads = await Thread.find({ userId: req.user._id }).sort({ updatedAt: -1 });
    return res.json(threads);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch threads" });
  }
});

// ================= GET SINGLE THREAD =================
router.get("/thread/:threadId", async (req, res) => {
  const { threadId } = req.params;
  try {
    const thread = await Thread.findOne({ threadId, userId: req.user._id });
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

// ================= CHAT ROUTE =================
router.post("/chat", async (req, res) => {
  const { threadId, message } = req.body;
  if (!threadId || !message) return res.status(400).json({ error: "Missing fields" });

  try {
    const user = await User.findById(req.user._id);

    // Enforce free limit
    if (!user.isPremium && user.usageCount >= FREE_LIMIT) {
      return res.status(403).json({
        error: "FREE_LIMIT_REACHED",
        message: `You've used all ${FREE_LIMIT} free messages. Upgrade to Premium for ₹199 to continue.`,
        usageCount: user.usageCount,
        isPremium: user.isPremium,
      });
    }

    let thread = await Thread.findOne({ threadId, userId: req.user._id });

    if (!thread) {
      thread = new Thread({
        threadId,
        userId: req.user._id,
        title: message.substring(0, 50),
        messages: [{ role: "user", content: message }],
      });
    } else {
      thread.messages.push({ role: "user", content: message });
    }

    const assistantReply = await getGeminiAPIResponse(message);
    thread.messages.push({ role: "model", content: assistantReply });
    thread.updatedAt = new Date();
    await thread.save();

    // Increment usage count
    user.usageCount += 1;
    await user.save();

    return res.json({
      reply: assistantReply,
      usageCount: user.usageCount,
      isPremium: user.isPremium,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
});

export default router;
