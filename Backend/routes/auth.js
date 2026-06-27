import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

const router = express.Router();

// ================= SIGNUP =================

router.post("/signup", async (req, res) => {

    try {

        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({
                error: "All fields are required",
            });
        }

        const existingUser = await User.findOne({
            email: email.toLowerCase(),
        });

        if (existingUser) {
            return res.status(409).json({
                error: "Email already exists",
            });
        }

        const user = await User.create({
            username,
            email: email.toLowerCase(),
            password,
        });

        const token = jwt.sign(
            {
                userId: user._id,
            },
            process.env.JWT_SECRET,
            {
                expiresIn: "7d",
            }
        );

        return res.status(201).json({
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
            },
        });

    } catch (err) {

        console.error("Signup Error");
        console.error(err);

        return res.status(500).json({
            error: err.message,
        });

    }

});

========= LOGIN =================
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      user: { id: user._id, username: user.username, email: user.email },
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ error: "Login failed" });
  }
});

// ================= GET CURRENT USER =================
router.get("/me", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ user });
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
});

export default router;
