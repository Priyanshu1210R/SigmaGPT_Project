import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import mongoose from "mongoose";

import chatRoutes from "./routes/chat.js";
import authRoutes from "./routes/auth.js";
import documentRoutes from "./routes/documents.js";
import { apiLimiter } from "./middlewares/rateLimit.js";
import { startDocumentWorker } from "./workers/documentWorker.js";

const app = express();

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

// Comma-separated list of allowed frontend origins, e.g.
// CORS_ORIGINS=https://sigmagpt-project-frontend.onrender.com,http://localhost:5173
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

// Behind Render/Heroku/nginx the real client IP is in X-Forwarded-For.
// Without this, every user shares the proxy's IP and rate limits hit everyone at once.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));

// ================= MIDDLEWARE =================

// CORS: auth uses a Bearer header (not cookies), so no credentials and no wildcard.
app.use(
  cors({
    origin(origin, cb) {
      // No Origin header = curl / server-to-server / same-origin; browsers always send one.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  })
);

// Only the chat endpoint needs a large body (base64 image). Everything else stays small.
// This parser must be registered before the global one (first parser to run wins).
app.use("/api/chat", express.json({ limit: "12mb" }));
app.use(express.json({ limit: "100kb" }));

// Global per-IP safety net (stricter limits live on login/signup/chat).
app.use("/api", apiLimiter);

// Serve static files
app.use(express.static(path.join(process.cwd(), "public")));

// ================= ROUTES =================

// Health Check
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "🚀 SigmaGPT Backend is Running",
  });
});

// Authentication Routes
app.use("/api/auth", authRoutes);

// Chat Routes
app.use("/api", chatRoutes);

// Document (RAG) Routes — multer parses multipart itself, so this must NOT sit
// behind the express.json() parsers registered above (they only handle JSON bodies
// and simply pass multipart requests through untouched, but keep routes separate for clarity).
app.use("/api", documentRoutes);

// ================= 404 HANDLER =================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
  });
});

// ================= GLOBAL ERROR HANDLER =================
// ✅ FIX: Express requires exactly 4 parameters for error-handling middleware.
//    The `next` parameter must be present even if unused — otherwise Express
//    treats it as a regular middleware and errors won't route here.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Global Error:");
  console.error(err);

  res.status(err.status || 500).json({
    success: false,
    // Don't leak internals on 5xx; 4xx (e.g. body too large) messages are safe.
    error: (err.status || 500) < 500 ? err.message : "Internal Server Error",
  });
});

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
