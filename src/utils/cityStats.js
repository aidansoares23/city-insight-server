const { db } = require("../config/firebase");
const { updatedTimestamp } = require("./timestamps");
const {
  toFiniteNumber,
  clamp0to100,
  medianRentToAffordability100,
  normalizeSafetyTo10,
} = require("../lib/numbers");
const { isPlainObject } = require("../lib/objects");
const { REQUIRED_RATING_KEYS: RATING_KEYS } = require("../lib/reviews");

/** Returns `0` if `n` is negative; otherwise returns `n` unchanged. */
function clampNonNegative(n) {
  return n < 0 ? 0 : n;
}

/** Coerces all rating keys to finite numbers; missing or non-numeric values become `0` (safe for aggregation). */
function normalizeRatings(ratings) {
  const ratingsInput = isPlainObject(ratings) ? ratings : {};
  const result = {};
  for (const key of RATING_KEYS)
    result[key] = Number.isFinite(Number(ratingsInput[key])) ? Number(ratingsInput[key]) : 0;
  return result;
}

/** Adds two rating objects element-wise across all rating keys. */
function addRatings(a, b) {
  const ratingsA = normalizeRatings(a);
  const ratingsB = normalizeRatings(b);
  const result = {};
  for (const key of RATING_KEYS) result[key] = ratingsA[key] + ratingsB[key];
  return result;
}

/** Subtracts rating object `b` from `a` element-wise across all rating keys. */
function subRatings(a, b) {
  const ratingsA = normalizeRatings(a);
  const ratingsB = normalizeRatings(b);
  const result = {};
  for (const key of RATING_KEYS) result[key] = ratingsA[key] - ratingsB[key];
  return result;
}

/** Divides each sum by `count` to produce per-key averages; returns `null` for each key if `count` is 0. */
function computeAverages(count, sums) {
  const totalCount = toFiniteNumber(count, 0);
  const normalizedSums = normalizeRatings(sums);
  const averages = {};
  for (const key of RATING_KEYS) averages[key] = totalCount > 0 ? normalizedSums[key] / totalCount : null;
  return averages;
}

/** Extracts `count` and `sums` from a `city_stats` document and returns `{ count, sums, averages }`. */
function computeAveragesFromStats(statsDoc) {
  const count = toFiniteNumber(statsDoc?.count, 0);
  const sums = normalizeRatings(statsDoc?.sums);
  return { count, sums, averages: computeAverages(count, sums) };
}

/**
 * Throws if any rating sum is below `-epsilon` (default `1e-6`).
 * Throws rather than clamping so aggregate bugs surface immediately instead of silently corrupting data.
 */
function assertSumsNonNegative({ cityId, sums, epsilon = 1e-6 }) {
  for (const key of RATING_KEYS) {
    const sumValue = toFiniteNumber(sums?.[key], 0);
    if (sumValue < -epsilon)
      throw new Error(`city_stats sums went negative for ${cityId}.${key} (${sumValue})`);
  }
}

/**
 * Computes a weighted livability score (0–100) from up to three signals.
 * Missing signals are dropped and remaining weights renormalized rather than treated as zero.
 *
 *   50%  review overall      (1–10 → 0–100)
 *   35%  safety score        (0–10 → 0–100)
 *   15%  rent affordability  (medianRent vs $3,500 ceiling → 0–100)
 *
 * @returns {{ version: "v0", score: number|null }}
 */
function computeLivabilityV0({ averages, metrics }) {
  const overallRating = toFiniteNumber(averages?.overall, NaN);
  const reviewScore = Number.isFinite(overallRating)
    ? clamp0to100(Math.round((overallRating / 10) * 100))
    : null;

  const rawSafetyScore = toFiniteNumber(metrics?.safetyScore, NaN);
  const safetyScore = Number.isFinite(rawSafetyScore)
    ? clamp0to100(Math.round(rawSafetyScore * 10))
    : null;

  const rentScore = medianRentToAffordability100(metrics?.medianRent);

  const signals = [
    { score: reviewScore, weight: 0.5  },
    { score: safetyScore, weight: 0.35 },
    { score: rentScore,   weight: 0.15 },
  ].filter((signal) => signal.score != null);

  if (signals.length === 0) return { version: "v0", score: null };

  const totalWeight = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const score = Math.round(
    signals.reduce((sum, signal) => sum + signal.score * (signal.weight / totalWeight), 0),
  );

  return { version: "v0", score };
}

/** Normalizes a raw `city_metrics` document into `{ cityId, medianRent, population, safetyScore }` with null-safe coercion. */
function normalizeFlatCityMetrics(cityId, metricsDoc) {
  const safeDoc = isPlainObject(metricsDoc) ? metricsDoc : {};
  return {
    cityId,
    medianRent:  Number.isFinite(Number(safeDoc.medianRent))  ? Number(safeDoc.medianRent)  : null,
    population:  Number.isFinite(Number(safeDoc.population))  ? Number(safeDoc.population)  : null,
    safetyScore: normalizeSafetyTo10(safeDoc.safetyScore),
  };
}

/**
 * Applies an incremental delta to `city_stats` in a Firestore transaction, then recomputes livability.
 * Use `deltaCount = +1` / `-1` and `deltaRatings` as the review's ratings when adding/removing a review.
 */
async function applyCityStatsDelta(cityId, { deltaCount, deltaRatings }) {
  const statsRef = db.collection("city_stats").doc(cityId);
  const metricsRef = db.collection("city_metrics").doc(cityId);

  return db.runTransaction(async (tx) => {
    const [statsSnap, metricsSnap] = await Promise.all([
      tx.get(statsRef),
      tx.get(metricsRef),
    ]);

    const prevStats = statsSnap.exists ? statsSnap.data() || {} : {};
    const nextCount = clampNonNegative(toFiniteNumber(prevStats.count, 0) + toFiniteNumber(deltaCount, 0));
    const nextSums = addRatings(normalizeRatings(prevStats.sums), normalizeRatings(deltaRatings));

    assertSumsNonNegative({ cityId, sums: nextSums });

    const averages = computeAverages(nextCount, nextSums);
    const metrics = normalizeFlatCityMetrics(cityId, metricsSnap.exists ? metricsSnap.data() || {} : {});
    const livability = computeLivabilityV0({ averages, metrics });

    const patch = { cityId, count: nextCount, sums: nextSums, livability, ...updatedTimestamp() };
    tx.set(statsRef, patch, { merge: true });
    return { stats: patch, livability };
  });
}

/** Recomputes and writes the livability score for a city from its current `city_stats` and `city_metrics` in a transaction. */
async function recomputeCityLivability(cityId) {
  const statsRef = db.collection("city_stats").doc(cityId);
  const metricsRef = db.collection("city_metrics").doc(cityId);

  return db.runTransaction(async (tx) => {
    const [statsSnap, metricsSnap] = await Promise.all([
      tx.get(statsRef),
      tx.get(metricsRef),
    ]);

    const { count, sums } = computeAveragesFromStats(statsSnap.exists ? statsSnap.data() || {} : {});
    const averages = computeAverages(count, sums);
    const metrics = normalizeFlatCityMetrics(cityId, metricsSnap.exists ? metricsSnap.data() || {} : {});
    const livability = computeLivabilityV0({ averages, metrics });

    tx.set(statsRef, { cityId, livability, ...updatedTimestamp() }, { merge: true });
    return livability;
  });
}

/** Full recompute: aggregates all reviews for a city, writes corrected `city_stats`, then calls `recomputeCityLivability`. */
async function recomputeCityStatsFromReviews(cityId) {
  const snap = await db.collection("reviews").where("cityId", "==", cityId).get();

  let count = 0;
  let sums = normalizeRatings({});
  for (const doc of snap.docs) {
    sums = addRatings(sums, normalizeRatings(doc.data()?.ratings));
    count += 1;
  }

  assertSumsNonNegative({ cityId, sums });

  const statsDoc = { cityId, count, sums, ...updatedTimestamp() };
  await db.collection("city_stats").doc(cityId).set(statsDoc, { merge: true });
  await recomputeCityLivability(cityId);
  return statsDoc;
}

module.exports = {
  normalizeRatings,
  addRatings,
  subRatings,

  assertSumsNonNegative,
  computeAverages,
  computeAveragesFromStats,
  normalizeFlatCityMetrics,

  computeLivabilityV0,
  recomputeCityLivability,

  applyCityStatsDelta,
  recomputeCityStatsFromReviews,
};
