// src/utils/cityStats.js
const { db } = require("../config/firebase");
const { updatedTimestamp } = require("./timestamps");

/**
 * Review rating keys used throughout stats aggregation.
 * Keep in sync with review validation.
 */
const RATING_KEYS = ["safety", "cost", "traffic", "cleanliness", "overall"];

/** -----------------------------
 * Small helpers
 * ----------------------------- */

function isPlainObject(x) {
  return x != null && typeof x === "object" && !Array.isArray(x);
}

/**
 * Convert to a finite number, otherwise fallback.
 * Default fallback is NaN to avoid silently treating missing as 0.
 */
function toFiniteNumber(x, fallback = NaN) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clampNonNegative(n) {
  return n < 0 ? 0 : n;
}

function clamp0to100(n) {
  return Math.max(0, Math.min(100, n));
}

/**
 * For sums/deltas, missing or non-numeric values become 0.
 * This is correct for aggregation math (controller validation enforces bounds).
 */
function normalizeRatings(ratings) {
  const src = isPlainObject(ratings) ? ratings : {};
  const out = {};
  for (const k of RATING_KEYS) out[k] = Number.isFinite(Number(src[k])) ? Number(src[k]) : 0;
  return out;
}

function addRatings(a, b) {
  const aa = normalizeRatings(a);
  const bb = normalizeRatings(b);
  const out = {};
  for (const k of RATING_KEYS) out[k] = aa[k] + bb[k];
  return out;
}

function subRatings(a, b) {
  const aa = normalizeRatings(a);
  const bb = normalizeRatings(b);
  const out = {};
  for (const k of RATING_KEYS) out[k] = aa[k] - bb[k];
  return out;
}

/**
 * Compute averages from count+sums. Null if count === 0.
 * NOTE: We do NOT store averages in Firestore anymore.
 */
function computeAverages(count, sums) {
  const c = toFiniteNumber(count, 0);
  const s = normalizeRatings(sums);

  const averages = {};
  for (const k of RATING_KEYS) {
    averages[k] = c > 0 ? s[k] / c : null;
  }
  return averages;
}

/**
 * Back-compat helper: given a stats doc (or partial), compute count/sums/averages.
 */
function computeAveragesFromStats(statsDoc) {
  const count = toFiniteNumber(statsDoc?.count, 0);
  const sums = normalizeRatings(statsDoc?.sums);
  const averages = computeAverages(count, sums);
  return { count, sums, averages };
}

/**
 * Guard to catch silent aggregate corruption early.
 * We do NOT clamp sums, because clamping hides bugs (double-deletes, wrong deltas).
 */
function assertSumsNonNegative({ cityId, sums, epsilon = 1e-6 }) {
  for (const k of RATING_KEYS) {
    const v = toFiniteNumber(sums?.[k], 0);
    if (v < -epsilon) {
      throw new Error(`city_stats sums went negative for ${cityId}.${k} (${v})`);
    }
  }
}

/** -----------------------------
 * Livability (v0 placeholder)
 * ----------------------------- */

/**
 * v0: blend of review overall (1–10 => 0–100) and objective safetyScore (0–100).
 * Key rule: missing metrics must be treated as missing (null), NOT 0.
 *
 * Returns MINIMAL shape only: { version, score }
 */
function computeLivabilityV0({ averages, metrics }) {
  // reviews overall (1–10) -> 0–100
  const overall10 = toFiniteNumber(averages?.overall, NaN);
  const reviewOverall100 = Number.isFinite(overall10)
    ? clamp0to100(Math.round((overall10 / 10) * 100))
    : null;

  // safetyScore expected 0–100 (objective metric)
  const safetyScoreRaw = toFiniteNumber(metrics?.safetyScore, NaN);
  const safetyScore100 = Number.isFinite(safetyScoreRaw) ? clamp0to100(Math.round(safetyScoreRaw)) : null;

  // Only blend what exists
  if (reviewOverall100 == null && safetyScore100 == null) {
    return { version: "v0", score: null };
  }

  let score;
  if (reviewOverall100 != null && safetyScore100 != null) {
    score = Math.round(0.55 * reviewOverall100 + 0.45 * safetyScore100);
  } else {
    score = reviewOverall100 ?? safetyScore100;
  }

  return { version: "v0", score };
}

/**
 * Read and normalize flat city_metrics doc into the fields we care about.
 * (Matches your current Firestore shape from the screenshot.)
 */
function normalizeFlatCityMetrics(cityId, metricsDoc) {
  const src = isPlainObject(metricsDoc) ? metricsDoc : {};

  // If you ever decide "0 means unknown", change this to:
  // safetyScore: Number(src.safetyScore) === 0 ? null : ...
  return {
    cityId,
    medianRent: Number.isFinite(Number(src.medianRent)) ? Number(src.medianRent) : null,
    population: Number.isFinite(Number(src.population)) ? Number(src.population) : null,
    safetyScore: Number.isFinite(Number(src.safetyScore)) ? Number(src.safetyScore) : null,
  };
}

/** -----------------------------
 * Firestore ops
 * ----------------------------- */

/**
 * Transactionally apply a delta to city stats (REVIEW AGGREGATES ONLY),
 * AND recompute livability inside the same transaction for a consistent snapshot.
 *
 * Stored doc stays minimal:
 * { cityId, count, sums, livability, updatedAt }
 */
async function applyCityStatsDelta(cityId, { deltaCount, deltaRatings }) {
  const statsRef = db.collection("city_stats").doc(cityId);
  const metricsRef = db.collection("city_metrics").doc(cityId);

  const dc = toFiniteNumber(deltaCount, 0);
  const dr = normalizeRatings(deltaRatings);

  return db.runTransaction(async (tx) => {
    const [statsSnap, metricsSnap] = await Promise.all([tx.get(statsRef), tx.get(metricsRef)]);

    const prev = statsSnap.exists ? (statsSnap.data() || {}) : {};
    const prevCount = toFiniteNumber(prev?.count, 0);
    const prevSums = normalizeRatings(prev?.sums);

    const nextCount = clampNonNegative(prevCount + dc);
    const nextSums = addRatings(prevSums, dr);

    assertSumsNonNegative({ cityId, sums: nextSums });

    const averages = computeAverages(nextCount, nextSums);

    const metricsDoc = metricsSnap.exists ? (metricsSnap.data() || {}) : {};
    const metrics = normalizeFlatCityMetrics(cityId, metricsDoc);

    const livability = computeLivabilityV0({ averages, metrics });

    const patch = {
      cityId,
      count: nextCount,
      sums: nextSums,
      livability,
      ...updatedTimestamp(),
    };

    tx.set(statsRef, patch, { merge: true });

    return { stats: patch, livability };
  });
}

/**
 * Recompute livability from stored review aggregates + current flat city_metrics.
 * Use this when metrics change (scripts/services) OR if you want to “repair” livability.
 *
 * Writes MINIMAL livability shape: { version, score } under city_stats/{cityId}.livability
 */
async function recomputeCityLivability(cityId) {
  const statsRef = db.collection("city_stats").doc(cityId);
  const metricsRef = db.collection("city_metrics").doc(cityId);

  return db.runTransaction(async (tx) => {
    const [statsSnap, metricsSnap] = await Promise.all([tx.get(statsRef), tx.get(metricsRef)]);

    const statsDoc = statsSnap.exists ? (statsSnap.data() || {}) : { cityId };
    const { count, sums } = computeAveragesFromStats(statsDoc);
    const averages = computeAverages(count, sums);

    const metricsDoc = metricsSnap.exists ? (metricsSnap.data() || {}) : {};
    const metrics = normalizeFlatCityMetrics(cityId, metricsDoc);

    const livability = computeLivabilityV0({ averages, metrics });

    const patch = {
      cityId,
      livability,
      ...updatedTimestamp(),
    };

    tx.set(statsRef, patch, { merge: true });
    return livability;
  });
}

/**
 * Recompute count+sums from the source of truth: reviews collection.
 * Writes minimal city_stats, then recomputes livability.
 */
async function recomputeCityStatsFromReviews(cityId) {
  const snap = await db.collection("reviews").where("cityId", "==", cityId).get();

  let count = 0;
  let sums = normalizeRatings({});

  for (const doc of snap.docs) {
    const r = doc.data();
    sums = addRatings(sums, normalizeRatings(r?.ratings));
    count += 1;
  }

  assertSumsNonNegative({ cityId, sums });

  const statsDoc = {
    cityId,
    count,
    sums,
    ...updatedTimestamp(),
  };

  await db.collection("city_stats").doc(cityId).set(statsDoc, { merge: true });

  await recomputeCityLivability(cityId);

  return statsDoc;
}

module.exports = {
  RATING_KEYS,

  normalizeRatings,
  addRatings,
  subRatings,

  computeAveragesFromStats,

  computeLivabilityV0,
  recomputeCityLivability,

  applyCityStatsDelta,
  recomputeCityStatsFromReviews,
};
