const rateLimit = require("express-rate-limit");

const { NODE_ENV } = require("../config/env");

/** express-rate-limit handler that returns a 429 JSON error response. */
function handler(req, res) {
  res.status(429).json({
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests. Please slow down and try again later.",
    },
  });
}

// General API limit — 300 req / 15 min per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: NODE_ENV === "test" ? 0 : 300, // 0 = disabled in tests
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler,
});

// Auth limit — 20 req / 15 min per IP (stricter for login)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: NODE_ENV === "test" ? 0 : 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler,
});

module.exports = { apiLimiter, authLimiter };
