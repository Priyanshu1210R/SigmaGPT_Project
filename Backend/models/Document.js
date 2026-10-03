import mongoose from "mongoose";

// Metadata for one uploaded file. The actual searchable content lives in
// DocumentChunk (one row per chunk, each with its own embedding vector).
const DocumentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  threadId: { type: String, required: true }, // documents are scoped to one chat thread
  fileName: { type: String, required: true },
  mimeType: { type: String, required: true },
  sizeBytes: { type: Number, required: true },
  status: {
    type: String,
    // queued = accepted, waiting for a worker; processing = a worker is on it.
    enum: ["queued", "processing", "ready", "failed"],
    default: "queued",
  },
  // Human-readable progress for the polling endpoint / UI, e.g. "Reading file", "Embedding".
  stage: { type: String, default: "Queued" },
  progress: { type: Number, default: 0, min: 0, max: 100 }, // percent
  chunkCount: { type: Number, default: 0 },
  error: { type: String, default: null }, // populated when status === "failed"
  createdAt: { type: Date, default: Date.now },
});

// Listing a thread's documents (sidebar/panel), newest first.
DocumentSchema.index({ threadId: 1, userId: 1, createdAt: -1 });

export default mongoose.model("Document", DocumentSchema);
