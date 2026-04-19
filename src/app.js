const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const { NODE_ENV, CLIENT_ORIGINS } = require("./config/env");

const cityRoutes = require("./routes/cityRoutes");
const meRoutes = require("./routes/meRoutes");
const authRoutes = require("./routes/authRoutes");
const aiRoutes = require("./routes/aiRoutes");

const { notFoundHandler, errorHandler } = require("./middleware/errorHandlers");
const { apiLimiter, authLimiter, aiLimiter, expensivePublicLimiter } = require("./middleware/rateLimiter");
const { warmCityListCache } = require("./services/cityService");

const app = express();

if (NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'"],
        styleSrc:   ["'self'", "'unsafe-inline'"],
        imgSrc:     ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        frameSrc:   ["'none'"],
        fontSrc:    ["'self'"],
        objectSrc:  ["'none'"],
      },
    },
  })
);
app.use(express.json());
app.use(cookieParser());

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(new Error("CORS_NOT_ALLOWED"));
      if (CLIENT_ORIGINS.includes(origin)) return cb(null, true);
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
  });
});

app.use("/api/auth/login", authLimiter);
app.use("/api/ai", aiLimiter);
// Tighter limit for public endpoints that trigger fetchAllCityRows() on cache miss
app.use("/api/cities", expensivePublicLimiter);
app.use("/api/", apiLimiter);

app.use("/api/auth", authRoutes);
app.use("/api/cities", cityRoutes);
app.use("/api/me", meRoutes);
app.use("/api/ai", aiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

// Warm the city list cache on startup to avoid a cold 900-read burst on first request
warmCityListCache().catch((err) =>
  console.warn("[startup] City list cache warm-up failed:", err.message),
);

module.exports = app;
