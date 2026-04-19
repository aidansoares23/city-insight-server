const { db } = require("../config/firebase");
const { updatedTimestamp } = require("./timestamps");
const {
  toFiniteNumber,
  clamp0to100,
  medianRentToAffordability100,
  normalizeSafetyTo10,
  rangeScore,
  rangeScoreInverted,
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

/**
 * Computes a weighted livability score (0–100) using dataset-relative (min–max) normalization.
 * Each signal is ranked within the observed range of all cities in the dataset rather than
 * against fixed absolute thresholds, ensuring the score distribution spans the full 0–100 range.
 * Missing signals are dropped and remaining weights renormalized, identical to v0.
 *
 *   45%  review overall      (min–max ranked across all cities with reviews)
 *   30%  safety score        (min–max ranked across all cities with safety data)
 *   15%  rent affordability  (min–max ranked, inverted — lower rent = higher score)
 *   10%  air quality (AQI)   (min–max ranked, inverted — lower AQI = better air = higher score)
 *
 * Norms are pre-computed by the livability pipeline and stored in `livability_config/norms`.
 * Falls back to `computeLivabilityV0` behaviour when norms are absent for a signal.
 *
 * @returns {{ version: "v1", score: number|null }}
 */
function computeLivabilityV1({ averages, metrics, norms }) {
  const overallRating = toFiniteNumber(averages?.overall, NaN);
  const reviewNorm = norms?.reviewOverall;
  const reviewScore =
    Number.isFinite(overallRating) && reviewNorm
      ? rangeScore(overallRating, reviewNorm.min, reviewNorm.max)
      : null;

  const rawSafety = toFiniteNumber(metrics?.safetyScore, NaN);
  const safetyNorm = norms?.safetyScore;
  const safetyScore =
    Number.isFinite(rawSafety) && safetyNorm
      ? rangeScore(rawSafety, safetyNorm.min, safetyNorm.max)
      : null;

  const rawRent = toFiniteNumber(metrics?.medianRent, NaN);
  const rentNorm = norms?.medianRent;
  const rentScore =
    Number.isFinite(rawRent) && rentNorm
      ? rangeScoreInverted(rawRent, rentNorm.min, rentNorm.max)
      : null;

  const rawAqi = toFiniteNumber(metrics?.aqiValue, NaN);
  const aqiNorm = norms?.aqiValue;
  const aqiScore =
    Number.isFinite(rawAqi) && aqiNorm
      ? rangeScoreInverted(rawAqi, aqiNorm.min, aqiNorm.max)
      : null;

  const signals = [
    { score: reviewScore, weight: 0.45 },
    { score: safetyScore, weight: 0.30 },
    { score: rentScore,   weight: 0.15 },
    { score: aqiScore,    weight: 0.10 },
  ].filter((signal) => signal.score != null);

  if (signals.length === 0) return { version: "v1", score: null };

  const totalWeight = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const score = Math.round(
    signals.reduce((sum, signal) => sum + signal.score * (signal.weight / totalWeight), 0),
  );

  return { version: "v1", score };
}

/**
 * Computes min/max distribution stats for each livability signal from a list of city data.
 * Used by the livability pipeline to produce the norms stored in `livability_config/norms`.
 * Returns `null` for a signal if fewer than 2 data points exist (degenerate range — rangeScore
 * would return null for every city, so the signal is unusable).
 *
 * @param {Array<{ averages: object, metrics: object }>} cityDataList
 * @returns {{ reviewOverall: {min, max, count}|null, safetyScore: {min, max, count}|null, medianRent: {min, max, count}|null, aqiValue: {min, max, count}|null }}
 */
function computeLivabilityNorms(cityDataList) {
  const reviewVals = [];
  const safetyVals = [];
  const rentVals   = [];
  const aqiVals    = [];

  for (const { averages, metrics } of cityDataList) {
    // Explicit null-check before toFiniteNumber: Number(null) === 0 (finite), so
    // null fields must be excluded before the isFinite guard can do its job.
    const ov = averages?.overall;
    if (ov != null && Number.isFinite(toFiniteNumber(ov, NaN))) reviewVals.push(toFiniteNumber(ov, NaN));

    const sv = metrics?.safetyScore;
    if (sv != null && Number.isFinite(toFiniteNumber(sv, NaN))) safetyVals.push(toFiniteNumber(sv, NaN));

    const rv = metrics?.medianRent;
    if (rv != null && Number.isFinite(toFiniteNumber(rv, NaN))) rentVals.push(toFiniteNumber(rv, NaN));

    const av = metrics?.aqiValue;
    if (av != null && Number.isFinite(toFiniteNumber(av, NaN))) aqiVals.push(toFiniteNumber(av, NaN));
  }

  function minMaxOrNull(vals) {
    if (vals.length < 2) return null;
    return { min: Math.min(...vals), max: Math.max(...vals), count: vals.length };
  }

  return {
    reviewOverall: minMaxOrNull(reviewVals),
    safetyScore:   minMaxOrNull(safetyVals),
    medianRent:    minMaxOrNull(rentVals),
    aqiValue:      minMaxOrNull(aqiVals),
  };
}

/** Normalizes a raw `city_metrics` document into `{ cityId, medianRent, population, safetyScore, aqiValue }` with null-safe coercion. */
function normalizeFlatCityMetrics(cityId, metricsDoc) {
  const safeDoc = isPlainObject(metricsDoc) ? metricsDoc : {};
  return {
    cityId,
    medianRent:  Number.isFinite(Number(safeDoc.medianRent))  ? Number(safeDoc.medianRent)  : null,
    population:  Number.isFinite(Number(safeDoc.population))  ? Number(safeDoc.population)  : null,
    safetyScore: normalizeSafetyTo10(safeDoc.safetyScore),
    aqiValue:    Number.isFinite(Number(safeDoc.aqiValue))    ? Number(safeDoc.aqiValue)    : null,
  };
}

/**
 * Applies an incremental delta to `city_stats` in a Firestore transaction, then recomputes livability.
 * Use `deltaCount = +1` / `-1` and `deltaRatings` as the review's ratings when adding/removing a review.
 */
async function applyCityStatsDelta(cityId, { deltaCount, deltaRatings }) {
  const statsRef   = db.collection("city_stats").doc(cityId);
  const metricsRef = db.collection("city_metrics").doc(cityId);
  const normsRef   = db.collection("livability_config").doc("norms");

  return db.runTransaction(async (tx) => {
    const [statsSnap, metricsSnap, normsSnap] = await Promise.all([
      tx.get(statsRef),
      tx.get(metricsRef),
      tx.get(normsRef),
    ]);

    const prevStats = statsSnap.exists ? statsSnap.data() || {} : {};
    const nextCount = clampNonNegative(toFiniteNumber(prevStats.count, 0) + toFiniteNumber(deltaCount, 0));
    const nextSums = addRatings(normalizeRatings(prevStats.sums), normalizeRatings(deltaRatings));

    assertSumsNonNegative({ cityId, sums: nextSums });

    const averages = computeAverages(nextCount, nextSums);
    const metrics  = normalizeFlatCityMetrics(cityId, metricsSnap.exists ? metricsSnap.data() || {} : {});
    const norms    = normsSnap.exists ? normsSnap.data() : null;
    const livability = norms
      ? computeLivabilityV1({ averages, metrics, norms })
      : computeLivabilityV0({ averages, metrics });

    const patch = { cityId, count: nextCount, sums: nextSums, livability, ...updatedTimestamp() };
    tx.set(statsRef, patch, { merge: true });
    return { stats: patch, livability };
  });
}

/** Recomputes and writes the livability score for a city from its current `city_stats`, `city_metrics`, and `livability_config/norms` in a transaction. */
async function recomputeCityLivability(cityId) {
  const statsRef   = db.collection("city_stats").doc(cityId);
  const metricsRef = db.collection("city_metrics").doc(cityId);
  const normsRef   = db.collection("livability_config").doc("norms");

  return db.runTransaction(async (tx) => {
    const [statsSnap, metricsSnap, normsSnap] = await Promise.all([
      tx.get(statsRef),
      tx.get(metricsRef),
      tx.get(normsRef),
    ]);

    const { count, sums } = computeAveragesFromStats(statsSnap.exists ? statsSnap.data() || {} : {});
    const averages = computeAverages(count, sums);
    const metrics  = normalizeFlatCityMetrics(cityId, metricsSnap.exists ? metricsSnap.data() || {} : {});
    const norms    = normsSnap.exists ? normsSnap.data() : null;
    const livability = norms
      ? computeLivabilityV1({ averages, metrics, norms })
      : computeLivabilityV0({ averages, metrics });

    tx.set(statsRef, { cityId, livability, ...updatedTimestamp() }, { merge: true });
    return livability;
  });
}

/**
 * Like `recomputeCityLivability` but accepts pre-fetched norms, skipping the
 * `livability_config/norms` read inside the transaction. Use this when recomputing
 * many cities in a batch so norms are only read once.
 */
async function recomputeCityLivabilityWithNorms(cityId, norms) {
  const statsRef   = db.collection("city_stats").doc(cityId);
  const metricsRef = db.collection("city_metrics").doc(cityId);

  return db.runTransaction(async (tx) => {
    const [statsSnap, metricsSnap] = await Promise.all([
      tx.get(statsRef),
      tx.get(metricsRef),
    ]);

    const { count, sums } = computeAveragesFromStats(statsSnap.exists ? statsSnap.data() || {} : {});
    const averages = computeAverages(count, sums);
    const metrics  = normalizeFlatCityMetrics(cityId, metricsSnap.exists ? metricsSnap.data() || {} : {});
    const livability = norms
      ? computeLivabilityV1({ averages, metrics, norms })
      : computeLivabilityV0({ averages, metrics });

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
  computeLivabilityV1,
  computeLivabilityNorms,
  recomputeCityLivability,
  recomputeCityLivabilityWithNorms,

  applyCityStatsDelta,
  recomputeCityStatsFromReviews,
};
