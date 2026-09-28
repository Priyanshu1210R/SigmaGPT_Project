import rateLimit from "express-rate-limit";

const json429 = (message) => (req, res) =>
  res.status(429).json({ error: "RATE_LIMITED", message });

// Broad safety net for every /api request, per IP.
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: json429("Too many requests. Please slow down."),
});

// Brute-force protection on login (failed attempts only count).
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: json429("Too many login attempts. Try again in 15 minutes."),
});

// Stop mass account creation (each account = 20 free Gemini calls).
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: json429("Too many signups from this network. Try again later."),
});

// Per-USER limit on the expensive endpoint. Must run after authMiddleware.
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (req) => String(req.user._id),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: json429("You're sending messages too fast. Wait a moment and try again."),
});
