// Standalone worker process: `npm run worker`.
// Use this on a separate Render "Background Worker" (and set RUN_WORKER_IN_API=false on the web
// service) so CPU-heavy PDF parsing never competes with request handling.
import "dotenv/config";
import mongoose from "mongoose";
import { startDocumentWorker } from "./workers/documentWorker.js";

for (const key of ["MONGODB_URL", "GEMINI_API_KEY"]) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
}

await mongoose.connect(process.env.MONGODB_URL);
console.log("✅ Worker connected to MongoDB");
const worker = startDocumentWorker();

const shutdown = async () => {
  await worker.stop();
  await mongoose.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
