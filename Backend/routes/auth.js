import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import authMiddleware from "../middlewares/authMiddleware.js";

const router = express.Router();

// ================= SIGNUP =================
router.post("/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: "All fields are required" });

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser)
      return res.status(409).json({ error: "Email already exists" });

    const user = await User.create({ username, email: email.toLowerCase(), password });

    const token = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });

    return res.status(201).json({
      message: "User registered successfully",
      token,
      user: { id: user._id, username: user.username, email: user.email, usageCount: user.usageCount, isPremium: user.isPremium },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ================= LOGIN =================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required" });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(401).json({ error: "Invalid email or password" });

    const token = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });

    return res.status(200).json({
      message: "Login successful",
      token,
      user: { id: user._id, username: user.username, email: user.email, usageCount: user.usageCount, isPremium: user.isPremium },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ================= GET CURRENT USER =================
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer "))
      return res.status(401).json({ error: "Unauthorized" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });

    return res.status(200).json({ user });
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
});

// ================= UPDATE PROFILE (Settings) =================
router.put("/update-profile", authMiddleware, async (req, res) => {
  try {
    const { username, email, currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Update username
    if (username && username.trim()) user.username = username.trim();

    // Update email
    if (email && email.toLowerCase() !== user.email) {
      const emailExists = await User.findOne({ email: email.toLowerCase(), _id: { $ne: user._id } });
      if (emailExists) return res.status(409).json({ error: "Email already in use" });
      user.email = email.toLowerCase();
    }

    // Update password
    if (newPassword) {
      if (!currentPassword) return res.status(400).json({ error: "Current password is required to set a new password" });
      const isMatch = await user.comparePassword(currentPassword);
      if (!isMatch) return res.status(401).json({ error: "Current password is incorrect" });
      if (newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });
      user.password = newPassword;
    }

    await user.save();

    // Issue a new token (email may have changed)
    const token = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });

    return res.status(200).json({
      message: "Profile updated successfully",
      token,
      user: { id: user._id, username: user.username, email: user.email, usageCount: user.usageCount, isPremium: user.isPremium },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ================= UPGRADE TO PREMIUM =================
router.post("/upgrade", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.isPremium) return res.status(400).json({ error: "Already on Premium plan" });

    // In a real app you would verify payment here before upgrading
    user.isPremium = true;
    await user.save();

    return res.status(200).json({
      message: "Upgraded to Premium successfully",
      user: { id: user._id, username: user.username, email: user.email, usageCount: user.usageCount, isPremium: user.isPremium },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ================= REGISTERED USERS COUNT =================
router.get("/users-count", authMiddleware, async (req, res) => {
  try {
    const count = await User.countDocuments();
    return res.status(200).json({ count });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
