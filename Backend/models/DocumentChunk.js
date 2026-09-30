import mongoose from "mongoose";

// One retrievable slice of an uploaded document, plus its embedding vector.
// Kept as its own collection (rather than embedded in Document) so an Atlas
// Vector Search index can be built directly on `embedding`.
const DocumentChunkSchema = new mongoose.Schema({
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  threadId: { type: String, required: true },
  fileName: { type: String, required: true }, // denormalized for cheap citation rendering
  chunkIndex: { type: Number, required: true },
  text: { type: String, required: true },
  embedding: { type: [Number], required: true },
  createdAt: { type: Date, default: Date.now },
});

// Used by the local cosine-similarity fallback, and by delete-on-cascade.
DocumentChunkSchema.index({ threadId: 1, userId: 1 });
DocumentChunkSchema.index({ documentId: 1 });

export default mongoose.model("DocumentChunk", DocumentChunkSchema);
