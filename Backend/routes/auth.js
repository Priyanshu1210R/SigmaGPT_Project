import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import authMiddleware from "../middlewares/authMiddleware.js";
import { loginLimiter, signupLimiter } from "../middlewares/rateLimit.js";

const router = express.Router();

// ================= SIGNUP =================
router.post("/signup", signupLimiter, async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: "All fields are required" });
    if ([username, email, password].some((v) => typeof v !== "string"))
      return res.status(400).json({ error: "Invalid input" });

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
    // e.g. password shorter than the schema's minlength: a client error, not a server fault.
    if (err?.name === "ValidationError") return res.status(400).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ================= LOGIN =================
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required" });
    if (typeof email !== "string" || typeof password !== "string")
      return res.status(400).json({ error: "Invalid input" });

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
router.get("/me", authMiddleware, (req, res) => {
  // authMiddleware already loaded the user (without the password hash).
  return res.status(200).json({ user: req.user });
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
// Anyone could POST here and grant themselves Premium for free, so this is OFF by default.
// Enable ONLY for local demos: ENABLE_DEMO_UPGRADE=true (ignored when NODE_ENV=production).
// Before launch, replace with a payment webhook (Razorpay/Stripe) that verifies the payment.
const demoUpgradeEnabled = () =>
  process.env.ENABLE_DEMO_UPGRADE === "true" && process.env.NODE_ENV !== "production";

router.post("/upgrade", authMiddleware, async (req, res) => {
  if (!demoUpgradeEnabled()) {
    return res.status(501).json({ error: "Premium upgrades aren't available yet." });
  }
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
