import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import mongoose from "mongoose";

import chatRoutes from "./routes/chat.js";
import authRoutes from "./routes/auth.js";

const app = express();

// ================= CONFIG =================

const PORT = process.env.PORT || 8080;
const MONGODB_URL = process.env.MONGODB_URL;

// ================= MIDDLEWARE =================

// Parse JSON
app.use(express.json({ limit: "12mb" }));

// Parse URL Encoded Data
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

// Enable CORS
app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);

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
    error: err.message || "Internal Server Error",
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
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Server Startup Failed");
    console.error(err);
    process.exit(1);
  }
};

startServer();
