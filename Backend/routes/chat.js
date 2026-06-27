import express from "express";
import Thread from "../models/Thread.js";
import getGeminiAPIResponse from "../utils/gemini.js";
import authMiddleware from "../middlewares/authMiddleware.js";

const router = express.Router();

// All chat routes require auth
router.use(authMiddleware);

// ================= GET ALL THREADS (for logged-in user) =================
router.get("/thread", async (req, res) => {
  try {
    const threads = await Thread.find({ userId: req.user._id }).sort({ updatedAt: -1 });
    return res.json(threads);
  } catch (err) {
    console.log(err);
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
    console.log(err);
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
    console.log(err);
    return res.status(500).json({ error: "Failed to delete thread" });
  }
});

// ================= CHAT ROUTE =================
router.post("/chat", async (req, res) => {
  const { threadId, message } = req.body;
  if (!threadId || !message) return res.status(400).json({ error: "Missing fields" });

  try {
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

    return res.json({ reply: assistantReply });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
});

export default router;
