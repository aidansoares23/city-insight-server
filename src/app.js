// src/app.js
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");

// Route modules
const cityRoutes = require("./routes/cityRoutes");
const meRoutes = require("./routes/meRoutes");
const authRoutes = require("./routes/authRoutes"); // NEW

const { notFoundHandler, errorHandler } = require("./middleware/errorHandlers");

const app = express();

app.set("trust proxy", 1); // IMPORTANT for Render/proxies + secure cookies

app.use(helmet());
app.use(express.json());
app.use(cookieParser());

// CORS allowlist
const allowlist = (process.env.CLIENT_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// app.use(
//   cors({
//     origin(origin, cb) {
//       if (!origin) return cb(null, true);
//       if (allowlist.includes(origin)) return cb(null, true);
//       return cb(new Error(`CORS blocked origin: ${origin}`));
//     },
//     credentials: true, // REQUIRED for cookies
//   }),
// );
// app.use(
//   cors({
//     origin(origin, cb) {
//       if (!origin) return cb(null, true);
//       if (allowlist.includes(origin)) return cb(null, true);
//       return cb(null, false); // <- don't throw
//     },
//     credentials: true,
//   }),
// );

// // If you want a consistent JSON error for disallowed origins:
// app.use((err, req, res, next) => {
//   if (err && String(err.message || "").startsWith("CORS")) {
//     return res.status(403).json({
//       error: { code: "CORS", message: "Origin not allowed" },
//     });
//   }
//   next(err);
// });
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl / server-to-server
      if (allowlist.includes(origin)) return cb(null, true);
      return cb(new Error("CORS_NOT_ALLOWED"));
    },
    credentials: true,
  }),
);

app.use((err, req, res, next) => {
  if (err && err.message === "CORS_NOT_ALLOWED") {
    return res.status(403).json({
      error: { code: "CORS", message: "Origin not allowed" },
    });
  }
  next(err);
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "city-insight-api",
    ts: new Date().toISOString(),
    env: process.env.NODE_ENV || "development",
  });
});

// Routes
app.use("/api/auth", authRoutes); // NEW
app.use("/api/cities", cityRoutes);
app.use("/api/me", meRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
