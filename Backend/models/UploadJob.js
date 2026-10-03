import mongoose from "mongoose";

// Durable work queue for document indexing, backed by MongoDB (no Redis needed).
// One job per uploaded Document. The raw file bytes live here (not in memory) so a
// restart/redeploy mid-processing doesn't lose the upload — the job is simply re-claimed.
// `fileData` is dropped as soon as the job finishes so this collection stays small.
const UploadJobSchema = new mongoose.Schema({
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  threadId: { type: String, required: true },
  mimeType: { type: String, required: true },
  fileData: { type: Buffer, select: false }, // up to 15MB; must be explicitly selected by the worker

  status: { type: String, enum: ["queued", "processing", "done", "failed"], default: "queued" },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 3 },
  runAfter: { type: Date, default: Date.now }, // retry backoff: not claimable before this time
  leaseExpiresAt: { type: Date, default: null }, // a "processing" job past this is presumed orphaned (crash/redeploy)
  lastError: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
  finishedAt: { type: Date, default: null },
});

// Worker claim query: oldest claimable job first.
UploadJobSchema.index({ status: 1, runAfter: 1, createdAt: 1 });
UploadJobSchema.index({ status: 1, leaseExpiresAt: 1 });
// Per-user "active jobs" cap + cascade on document delete.
UploadJobSchema.index({ userId: 1, status: 1 });
UploadJobSchema.index({ documentId: 1 });
// Finished job records are just an audit trail — expire them after a week.
UploadJobSchema.index({ finishedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export default mongoose.model("UploadJob", UploadJobSchema);
