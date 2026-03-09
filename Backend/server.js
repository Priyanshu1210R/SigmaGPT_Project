import "dotenv/config";
import { setDefaultResultOrder, setServers } from 'node:dns/promises';
import express from "express";
import cors from "cors";
import path from "path";  // ADD THIS
import mongoose from "mongoose";
import chatRoutes from "./routes/chat.js";

const app = express();
const PORT = process.env.PORT || 8080;  // Render uses PORT env var

// Fix DNS
setServers(['8.8.8.8', '1.1.1.1']);
setDefaultResultOrder('ipv4first');

app.use(express.json());
app.use(cors());

// ADD THIS: Serve static files from 'public' folder
app.use(express.static(path.join(process.cwd(), 'public')));

app.use("/api", chatRoutes);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URL);
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.log("❌ Failed:", err.message);
  }
};

app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  connectDB();
});

// app.post("/test", async (req, res) => {
//     const API_KEY = process.env.GEMINI_API_KEY;
    
//     // RECOMMENDED FOR FREE TIER (Feb 2026):
//     // "gemini-2.5-flash" -> Best balance of speed, 1M context, and daily free quota.
//     // "gemini-2.5-flash-lite" -> Use this if you need higher Requests Per Day (up to 1,000).
//     const MODEL = "gemini-2.5-flash"; 
    
//     const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

//     const options = {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({
//             contents: [{
//                 parts: [{ text: req.body.message }]
//             }]
//         })
//     };

//     try {
//         const response = await fetch(url, options);
//         const data = await response.json();

//         if (data.error) {
//             console.error("Gemini API Error:", data.error.message);
//             return res.status(data.error.code || 500).json({ error: data.error.message });
//         }

//         // Response handling for stable Gemini 2.5
//         const reply = data.candidates[0].content.parts[0].text;
//         res.send(reply);
//     } catch (err) {
//         console.error("Internal Server Error:", err);
//         res.status(500).send("Something went wrong on our end.");
//     }
// });

// app.listen(PORT, () => {
//     console.log(`Server running on http://localhost:${PORT}`);
// });
