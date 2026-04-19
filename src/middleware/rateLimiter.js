const rateLimit = require("express-rate-limit");

const { NODE_ENV } = require("../config/env");
const { db, admin } = require("../config/firebase");

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

// AI limit — tight because each query can trigger up to 8 Anthropic API calls
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: NODE_ENV === "test" ? 0 : 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler,
});

// Expensive public endpoint limit — applied to routes that trigger fetchAllCityRows()
// on cache miss (~900 Firestore reads). Tighter than the general limit to protect
// against cache-busting abuse from a single IP.
const expensivePublicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: NODE_ENV === "test" ? 0 : 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler,
});

// ---------------------------------------------------------------------------
// Per-user daily AI quota — enforced in addition to the IP-based aiLimiter.
// Persisted in Firestore (collection: aiQuota, doc: userId) so the quota
// survives server restarts. Resets at midnight UTC.
// ---------------------------------------------------------------------------
const AI_DAILY_USER_LIMIT = 50;

/**
 * Express middleware: enforces a per-user daily AI query quota.
 * Must be placed after requireAuth so req.user is populated.
 */
async function userAiQuotaMiddleware(req, res, next) {
  if (NODE_ENV === "test") return next();

  const userId = req.user?.userId;
  if (!userId) return next(); // unauthenticated — let requireAuth handle it

  const now = Date.now();
  const todayMidnightUtc = new Date();
  todayMidnightUtc.setUTCHours(24, 0, 0, 0); // next midnight UTC
  const resetAt = todayMidnightUtc.getTime();

  try {
    const ref = db.collection("aiQuota").doc(userId);
    const snap = await ref.get();

    if (!snap.exists || now >= snap.data().resetAt) {
      // First query today or window expired — reset counter
      await ref.set({ count: 1, resetAt });
      return next();
    }

    const { count } = snap.data();

    if (count >= AI_DAILY_USER_LIMIT) {
      return res.status(429).json({
        error: {
          code: "DAILY_AI_LIMIT",
          message: `Daily AI query limit of ${AI_DAILY_USER_LIMIT} reached. Resets at midnight UTC.`,
        },
      });
    }

    await ref.update({ count: admin.firestore.FieldValue.increment(1) });
    next();
  } catch (err) {
    // Fail open so a Firestore outage doesn't block all AI queries
    console.error("[aiQuota] Firestore error, allowing request:", err.message);
    next();
  }
}

module.exports = { apiLimiter, authLimiter, aiLimiter, expensivePublicLimiter, userAiQuotaMiddleware };
