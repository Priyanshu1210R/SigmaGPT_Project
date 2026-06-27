import "dotenv/config";
import { setDefaultResultOrder, setServers } from 'node:dns/promises';
import express from "express";
import cors from "cors";
import path from "path";
import mongoose from "mongoose";
import chatRoutes from "./routes/chat.js";
import authRoutes from "./routes/auth.js";

const app = express();
const PORT = process.env.PORT || 8080;

// Fix DNS
setServers(['8.8.8.8', '1.1.1.1']);
setDefaultResultOrder('ipv4first');

app.use(express.json());
app.use(cors());

// Serve static files from 'public' folder
app.use(express.static(path.join(process.cwd(), 'public')));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api", chatRoutes);

const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URL);

    console.log("✅ Connected to MongoDB");

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("MongoDB Connection Error");
    console.error(err);
    process.exit(1);
  }
};

startServer();
