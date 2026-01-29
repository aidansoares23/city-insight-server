// src/app.js
const express = require("express");
const cors = require("cors");

// Route modules
const cityRoutes = require("./routes/cityRoutes");
const meRoutes = require("./routes/meRoutes");

// Error handling middleware
const { notFoundHandler, errorHandler } = require("./middleware/errorHandlers");

const app = express();

/**
 * --------------------------
 * Global Middleware
 * --------------------------
 */

// Parse JSON bodies
app.use(express.json());

// CORS
// Use comma-separated allowlist, e.g.
// CLIENT_ORIGINS="http://localhost:5173,https://your-app.vercel.app"
const allowlist = (process.env.CLIENT_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser clients (curl/postman) with no Origin header
      if (!origin) return cb(null, true);

      if (allowlist.includes(origin)) return cb(null, true);

      return cb(new Error(`CORS blocked origin: ${origin}`));
    },
    credentials: true,
  })
);

// Basic health check (cheap, no DB)
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "city-insight-api",
    ts: new Date().toISOString(),
    env: process.env.NODE_ENV || "development",
  });
});

/**
 * --------------------------
 * Routes
 * --------------------------
 * All routes are mounted under /api
 */
app.use("/api/cities", cityRoutes); // cities + city details + city-scoped reviews (nested)
app.use("/api/me", meRoutes); // user dashboard endpoints

/**
 * --------------------------
 * Error Handling
 * --------------------------
 */
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
