// src/controllers/reviewController.js
const crypto = require("crypto");
const admin = require("firebase-admin");
const { db } = require("../config/firebase");
const { serverTimestamps, updatedTimestamp } = require("../utils/timestamps");
const {
  normalizeRatings,
  addRatings,
  subRatings,
  computeLivabilityV0,
} = require("../utils/cityStats");

const REQUIRED_RATING_KEYS = [
  "safety",
  "cost",
  "traffic",
  "cleanliness",
  "overall",
];
const MAX_COMMENT_LEN = 800;

// -----------------------------
// Helpers
// -----------------------------
function tsToIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate().toISOString();
  if (ts._seconds != null) return new Date(ts._seconds * 1000).toISOString();
  return null;
}

function withIsoTimestamps(obj) {
  if (!obj || typeof obj !== "object") return obj;
  return {
    ...obj,
    createdAtIso: tsToIso(obj.createdAt),
    updatedAtIso: tsToIso(obj.updatedAt),
  };
}

function isPlainObject(x) {
  return x != null && typeof x === "object" && !Array.isArray(x);
}

function validateRatings(ratings) {
  const errors = [];
  if (!isPlainObject(ratings)) return ["ratings is required (object)"];

  for (const key of REQUIRED_RATING_KEYS) {
    const val = ratings[key];

    if (typeof val !== "number" || !Number.isFinite(val)) {
      errors.push(`ratings.${key} must be a finite number`);
      continue;
    }

    // Optional but recommended for consistency:
    if (!Number.isInteger(val))
      errors.push(`ratings.${key} must be an integer`);

    if (val < 1 || val > 10)
      errors.push(`ratings.${key} must be between 1 and 10`);
  }
  return errors;
}

function validateReviewBody(body) {
  const errors = [];
  if (!isPlainObject(body)) {
    return { ok: false, errors: ["Body must be an object"] };
  }

  errors.push(...validateRatings(body.ratings));

  if (body.comment != null) {
    if (typeof body.comment !== "string") {
      errors.push("comment must be a string or null");
    } else if (body.comment.length > MAX_COMMENT_LEN) {
      errors.push(`comment must be <= ${MAX_COMMENT_LEN} chars`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Normalize incoming ratings into a clean, consistent stored shape.
 * - integer values
 * - guaranteed keys
 */
function normalizeIncomingRatings(ratings) {
  const out = {};
  for (const k of REQUIRED_RATING_KEYS) {
    out[k] = Number.isFinite(Number(ratings?.[k]))
      ? Math.round(Number(ratings[k]))
      : 0;
  }
  return out;
}

function normalizeIncomingComment(comment) {
  if (comment == null) return null;
  const s = String(comment).trim();
  return s ? s : null;
}

/**
 * Deterministic, non-guessable doc id.
 * Same user+city => same id (enforces 1 review per user per city).
 */
function makeReviewId(userId, cityId) {
  const salt = process.env.REVIEW_ID_SALT;
  if (!salt) throw new Error("Missing REVIEW_ID_SALT in env");

  return crypto
    .createHash("sha256")
    .update(`${userId}:${cityId}:${salt}`)
    .digest("hex")
    .slice(0, 32);
}

function assertSumsNonNegative({ cityId, sums, epsilon = 1e-6 }) {
  for (const k of REQUIRED_RATING_KEYS) {
    const v = Number(sums?.[k] ?? 0);
    if (Number.isFinite(v) && v < -epsilon) {
      throw new Error(
        `city_stats sums went negative for ${cityId}.${k} (${v})`,
      );
    }
  }
}

function computeAveragesFromCountSums(count, sums) {
  const c = Number.isFinite(Number(count)) ? Number(count) : 0;
  const s = normalizeRatings(sums);
  const averages = {};
  for (const k of REQUIRED_RATING_KEYS) {
    averages[k] = c > 0 ? s[k] / c : null;
  }
  return { count: c, sums: s, averages };
}

function normalizeMetricsForLivability(cityId, metricsDoc) {
  const m = isPlainObject(metricsDoc) ? metricsDoc : {};

  // Back-compat: support either medianRent or medianGrossRent.
  const medianRent = Number.isFinite(Number(m.medianRent))
    ? Number(m.medianRent)
    : Number.isFinite(Number(m.medianGrossRent))
      ? Number(m.medianGrossRent)
      : null;

  return {
    cityId,
    medianRent,
    population: Number.isFinite(Number(m.population))
      ? Number(m.population)
      : null,
    safetyScore: Number.isFinite(Number(m.safetyScore))
      ? Number(m.safetyScore)
      : null, // 0–100 expected
  };
}

/**
 * Shape for PUBLIC review payloads.
 * Intentionally excludes userId.
 */
function toPublicReview(docId, data) {
  return withIsoTimestamps({
    // TODO: MAKE SURE THIS IS OK
    // id: docId,
    cityId: data.cityId,
    ratings: data.ratings,
    comment: data.comment ?? null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  });
}

/**
 * Shape for "my review" payloads (auth-only).
 */
function toMyReview(docId, data) {
  return withIsoTimestamps({
    id: docId,
    cityId: data.cityId,
    userId: data.userId, // optional; remove if you prefer
    ratings: data.ratings,
    comment: data.comment ?? null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  });
}

// Cursor helpers (stable pagination)
// Cursor shape: { id: string, createdAtIso: string|null }
function buildNextCursor(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    createdAtIso: tsToIso(data.createdAt),
  };
}

function parseCursorFromQuery(req) {
  const cursorId = req.query.cursorId
    ? String(req.query.cursorId).trim()
    : null;
  const cursorCreatedAtIso = req.query.cursorCreatedAtIso
    ? String(req.query.cursorCreatedAtIso).trim()
    : null;

  if (cursorId && cursorCreatedAtIso) {
    const dt = new Date(cursorCreatedAtIso);
    if (!Number.isNaN(dt.valueOf())) {
      return {
        id: cursorId,
        createdAt: admin.firestore.Timestamp.fromDate(dt),
      };
    }
  }

  // Back-compat: after=<docId>
  const after = req.query.after ? String(req.query.after).trim() : null;
  if (after) return { afterIdOnly: after };

  return null;
}

// -----------------------------
// Handlers
// -----------------------------

/**
 * POST /api/cities/:slug/reviews
 * Create or update MY review for a city.
 *
 * Atomic guarantees:
 * - Review write and city_stats update occur in the SAME Firestore transaction.
 */
async function createOrUpdateReviewForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();

    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Missing or invalid auth" },
      });
    }

    const { ok, errors } = validateReviewBody(req.body);
    if (!ok) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid review payload",
          details: { errors },
        },
      });
    }

    const cleanUserId = String(userId).trim();
    const reviewId = makeReviewId(cleanUserId, cityId);

    const cityRef = db.collection("cities").doc(cityId);
    const reviewRef = db.collection("reviews").doc(reviewId);
    const statsRef = db.collection("city_stats").doc(cityId);
    const metricsRef = db.collection("city_metrics").doc(cityId);

    const incomingRatings = normalizeIncomingRatings(req.body.ratings);
    const incomingComment = normalizeIncomingComment(req.body.comment);

    const txResult = await db.runTransaction(async (tx) => {
      // Ensure city exists
      const citySnap = await tx.get(cityRef);
      if (!citySnap.exists) {
        const err = new Error("City not found");
        err.status = 404;
        err.code = "CITY_NOT_FOUND";
        throw err;
      }

      // Read existing review (if any)
      const reviewSnap = await tx.get(reviewRef);
      const isNew = !reviewSnap.exists;
      const prevRatingsRaw = reviewSnap.exists
        ? (reviewSnap.data() || {}).ratings
        : null;
      const prevRatings = normalizeRatings(prevRatingsRaw);

      // Read stats + metrics for consistent livability update
      const [statsSnap, metricsSnap] = await Promise.all([
        tx.get(statsRef),
        tx.get(metricsRef),
      ]);

      const prevStats = statsSnap.exists ? statsSnap.data() || {} : {};
      const prevCount = Number(prevStats.count ?? 0);
      const prevSums = normalizeRatings(prevStats.sums);

      // Compute delta
      const deltaCount = isNew ? 1 : 0;
      const deltaRatings = isNew
        ? normalizeRatings(incomingRatings)
        : subRatings(normalizeRatings(incomingRatings), prevRatings);

      // Apply next stats
      const nextCount = Math.max(0, prevCount + deltaCount);
      const nextSums = addRatings(prevSums, deltaRatings);

      assertSumsNonNegative({ cityId, sums: nextSums });

      const { averages } = computeAveragesFromCountSums(nextCount, nextSums);

      const metricsDoc = metricsSnap.exists ? metricsSnap.data() || {} : {};
      const metrics = normalizeMetricsForLivability(cityId, metricsDoc);
      const livability = computeLivabilityV0({ averages, metrics });

      // Write review
      const reviewPatch = {
        userId: cleanUserId,
        cityId,
        ratings: incomingRatings,
        comment: incomingComment,
        ...(isNew ? serverTimestamps() : updatedTimestamp()),
      };
      tx.set(reviewRef, reviewPatch, { merge: true });

      // Write stats (includes livability)
      const statsPatch = {
        cityId,
        count: nextCount,
        sums: nextSums,
        livability,
        ...updatedTimestamp(),
      };
      tx.set(statsRef, statsPatch, { merge: true });

      return { isNew };
    });

    // Return saved review
    const savedSnap = await reviewRef.get();
    const saved = savedSnap.data();

    return res.status(txResult.isNew ? 201 : 200).json({
      ok: true,
      created: txResult.isNew,
      review: toMyReview(reviewId, saved),
    });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({
        error: {
          code: err.code || "ERROR",
          message: err.message || "Request failed",
        },
      });
    }
    next(err);
  }
}

/**
 * GET /api/cities/:slug/reviews?pageSize=10&cursorId=...&cursorCreatedAtIso=...
 */
async function listReviewsForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();

    const rawPageSize = parseInt(req.query.pageSize || "10", 10);
    const pageSize = Math.max(
      1,
      Math.min(Number.isFinite(rawPageSize) ? rawPageSize : 10, 50),
    );

    let query = db
      .collection("reviews")
      .where("cityId", "==", cityId)
      .orderBy("createdAt", "desc")
      .orderBy(admin.firestore.FieldPath.documentId(), "desc")
      .limit(pageSize);

    const cursor = parseCursorFromQuery(req);

    // Preferred cursor: (createdAt, id)
    if (cursor?.id && cursor?.createdAt) {
      query = query.startAfter(cursor.createdAt, cursor.id);
    }

    // Back-compat cursor: after=<docId>
    if (!cursor?.id && cursor?.afterIdOnly) {
      const afterSnap = await db
        .collection("reviews")
        .doc(cursor.afterIdOnly)
        .get();
      if (afterSnap.exists) {
        const afterData = afterSnap.data() || {};
        if (afterData.cityId === cityId && afterData.createdAt) {
          query = query.startAfter(afterData.createdAt, afterSnap.id);
        }
      }
    }

    const snap = await query.get();
    const docs = snap.docs;

    const reviews = docs.map((d) => toPublicReview(d.id, d.data()));
    const nextCursor = docs.length
      ? buildNextCursor(docs[docs.length - 1])
      : null;

    res.json({ reviews, pageSize, nextCursor });
  } catch (err) {
    next(err);
  }
}

async function getReviewByIdForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();
    const reviewId = String(req.params.reviewId).trim();

    const snap = await db.collection("reviews").doc(reviewId).get();
    if (!snap.exists) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Review not found" },
      });
    }

    const data = snap.data();
    if (data.cityId !== cityId) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Review not found for this city" },
      });
    }

    return res.json({ review: toPublicReview(snap.id, data) });
  } catch (err) {
    next(err);
  }
}

async function getMyReviewForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();

    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Missing or invalid auth" },
      });
    }

    const reviewId = makeReviewId(String(userId).trim(), cityId);
    const snap = await db.collection("reviews").doc(reviewId).get();

    if (!snap.exists) return res.json({ review: null });

    return res.json({ review: toMyReview(snap.id, snap.data()) });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/cities/:slug/reviews/me
 */
async function deleteMyReviewForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();

    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Missing or invalid auth" },
      });
    }

    const reviewId = makeReviewId(String(userId).trim(), cityId);

    const cityRef = db.collection("cities").doc(cityId);
    const reviewRef = db.collection("reviews").doc(reviewId);
    const statsRef = db.collection("city_stats").doc(cityId);
    const metricsRef = db.collection("city_metrics").doc(cityId);

    await db.runTransaction(async (tx) => {
      const citySnap = await tx.get(cityRef);
      if (!citySnap.exists) {
        const err = new Error("City not found");
        err.status = 404;
        err.code = "CITY_NOT_FOUND";
        throw err;
      }

      const reviewSnap = await tx.get(reviewRef);
      if (!reviewSnap.exists) {
        const err = new Error("Review not found");
        err.status = 404;
        err.code = "NOT_FOUND";
        throw err;
      }

      const existing = reviewSnap.data() || {};
      const oldRatings = normalizeRatings(existing.ratings || {});

      const [statsSnap, metricsSnap] = await Promise.all([
        tx.get(statsRef),
        tx.get(metricsRef),
      ]);
      const prevStats = statsSnap.exists ? statsSnap.data() || {} : {};
      const prevCount = Number(prevStats.count ?? 0);
      const prevSums = normalizeRatings(prevStats.sums);

      // delta: -1 review, subtract old ratings
      const deltaCount = -1;
      const deltaRatings = subRatings({}, oldRatings);

      const nextCount = Math.max(0, prevCount + deltaCount);
      const nextSums = addRatings(prevSums, deltaRatings);

      assertSumsNonNegative({ cityId, sums: nextSums });

      const { averages } = computeAveragesFromCountSums(nextCount, nextSums);

      const metricsDoc = metricsSnap.exists ? metricsSnap.data() || {} : {};
      const metrics = normalizeMetricsForLivability(cityId, metricsDoc);
      const livability = computeLivabilityV0({ averages, metrics });

      // Delete review
      tx.delete(reviewRef);

      // Update stats
      const statsPatch = {
        cityId,
        count: nextCount,
        sums: nextSums,
        livability,
        ...updatedTimestamp(),
      };
      tx.set(statsRef, statsPatch, { merge: true });
    });

    return res.json({ ok: true, deleted: true });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({
        error: {
          code: err.code || "ERROR",
          message: err.message || "Request failed",
        },
      });
    }
    next(err);
  }
}

module.exports = {
  createOrUpdateReviewForCity,
  listReviewsForCity,
  getReviewByIdForCity,
  getMyReviewForCity,
  deleteMyReviewForCity,
};
