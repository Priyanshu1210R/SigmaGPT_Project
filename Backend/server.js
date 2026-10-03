import "dotenv/config";
import mongoose from "mongoose";

import app from "./app.js";
import { startDocumentWorker } from "./workers/documentWorker.js";

// ================= CONFIG =================

const PORT = process.env.PORT || 8080;
const MONGODB_URL = process.env.MONGODB_URL;

// Fail fast instead of crashing on the first request.
for (const key of ["MONGODB_URL", "JWT_SECRET", "GEMINI_API_KEY"]) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ================= DATABASE CONNECTION =================

const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URL);
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB Connection Failed");
    console.error(err);
    process.exit(1);
  }
};

// ================= START SERVER =================

const startServer = async () => {
  try {
    await connectDB();
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

    // Background document indexing. Runs inside the API process by default (fine for one small
    // instance); set RUN_WORKER_IN_API=false and run `npm run worker` as its own service to scale it
    // separately and keep PDF parsing off the request-serving process.
    const worker = process.env.RUN_WORKER_IN_API === "false" ? null : startDocumentWorker();

    const shutdown = async () => {
      server.close();
      await worker?.stop(); // let in-flight jobs finish; anything left is re-claimed after its lease expires
      await mongoose.disconnect();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (err) {
    console.error("❌ Server Startup Failed");
    console.error(err);
    process.exit(1);
  }
};

startServer();
