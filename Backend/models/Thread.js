import mongoose from "mongoose";

const MessageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ["user", "model"],
    required: true,
  },
  content: {
    type: String,
    default: "", // image-only messages have no text (required:true rejected "")
  },
  image: {
    type: String, // data URL: "data:image/png;base64,...."
    default: null,
  },
  // Present on model replies that used RAG — which retrieved chunks the answer is grounded in,
  // so citations survive a reload instead of only existing for the live SSE stream.
  citations: {
    type: [
      {
        _id: false,
        documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document" },
        fileName: String,
        chunkIndex: Number,
        text: String,
      },
    ],
    default: undefined,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

const ThreadSchema = new mongoose.Schema({
  threadId: {
    type: String,
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  title: {
    type: String,
    default: "New Chat",
  },
  messages: [MessageSchema],
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// threadId is only unique per user (a globally-unique index lets one user block another's IDs).
ThreadSchema.index({ userId: 1, threadId: 1 }, { unique: true });
// Sidebar listing: filter by user, sorted by recency.
ThreadSchema.index({ userId: 1, updatedAt: -1 });

export default mongoose.model("Thread", ThreadSchema);
