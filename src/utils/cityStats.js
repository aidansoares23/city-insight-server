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

function clampNonNegative(n) {
  return n < 0 ? 0 : n;
}

// Missing or non-numeric values become 0 — correct for aggregation math.
function normalizeRatings(ratings) {
  const src = isPlainObject(ratings) ? ratings : {};
  const out = {};
  for (const k of RATING_KEYS)
    out[k] = Number.isFinite(Number(src[k])) ? Number(src[k]) : 0;
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

function computeAverages(count, sums) {
  const c = toFiniteNumber(count, 0);
  const s = normalizeRatings(sums);
  const averages = {};
  for (const k of RATING_KEYS) averages[k] = c > 0 ? s[k] / c : null;
  return averages;
}

function computeAveragesFromStats(statsDoc) {
  const count = toFiniteNumber(statsDoc?.count, 0);
  const sums = normalizeRatings(statsDoc?.sums);
  return { count, sums, averages: computeAverages(count, sums) };
}

// Throws rather than clamping so aggregate bugs surface immediately.
function assertSumsNonNegative({ cityId, sums, epsilon = 1e-6 }) {
  for (const k of RATING_KEYS) {
    const v = toFiniteNumber(sums?.[k], 0);
    if (v < -epsilon)
      throw new Error(`city_stats sums went negative for ${cityId}.${k} (${v})`);
  }
}

/*
 * Weighted blend of up to three signals. Missing signals are dropped and
 * remaining weights renormalized rather than treated as zero.
 *
 *   50%  review overall      (1–10 → 0–100)
 *   35%  safety score        (0–10 → 0–100)
 *   15%  rent affordability  (medianRent vs $3500 ceiling → 0–100)
 */
function computeLivabilityV0({ averages, metrics }) {
  const overall10 = toFiniteNumber(averages?.overall, NaN);
  const reviewScore = Number.isFinite(overall10)
    ? clamp0to100(Math.round((overall10 / 10) * 100))
    : null;

  const safetyRaw = toFiniteNumber(metrics?.safetyScore, NaN);
  const safetyScore = Number.isFinite(safetyRaw)
    ? clamp0to100(Math.round(safetyRaw * 10))
    : null;

  const rentScore = medianRentToAffordability100(metrics?.medianRent);

  const signals = [
    { score: reviewScore, weight: 0.5  },
    { score: safetyScore, weight: 0.35 },
    { score: rentScore,   weight: 0.15 },
  ].filter((s) => s.score != null);

  if (signals.length === 0) return { version: "v0", score: null };

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const score = Math.round(
    signals.reduce((sum, s) => sum + s.score * (s.weight / totalWeight), 0),
  );

  return { version: "v0", score };
}

function normalizeFlatCityMetrics(cityId, metricsDoc) {
  const src = isPlainObject(metricsDoc) ? metricsDoc : {};
  return {
    cityId,
    medianRent:  Number.isFinite(Number(src.medianRent))  ? Number(src.medianRent)  : null,
    population:  Number.isFinite(Number(src.population))  ? Number(src.population)  : null,
    safetyScore: normalizeSafetyTo10(src.safetyScore),
  };
}

async function applyCityStatsDelta(cityId, { deltaCount, deltaRatings }) {
  const statsRef = db.collection("city_stats").doc(cityId);
  const metricsRef = db.collection("city_metrics").doc(cityId);

  return db.runTransaction(async (tx) => {
    const [statsSnap, metricsSnap] = await Promise.all([
      tx.get(statsRef),
      tx.get(metricsRef),
    ]);

    const prev = statsSnap.exists ? statsSnap.data() || {} : {};
    const nextCount = clampNonNegative(toFiniteNumber(prev.count, 0) + toFiniteNumber(deltaCount, 0));
    const nextSums = addRatings(normalizeRatings(prev.sums), normalizeRatings(deltaRatings));

    assertSumsNonNegative({ cityId, sums: nextSums });

    const averages = computeAverages(nextCount, nextSums);
    const metrics = normalizeFlatCityMetrics(cityId, metricsSnap.exists ? metricsSnap.data() || {} : {});
    const livability = computeLivabilityV0({ averages, metrics });

    const patch = { cityId, count: nextCount, sums: nextSums, livability, ...updatedTimestamp() };
    tx.set(statsRef, patch, { merge: true });
    return { stats: patch, livability };
  });
}

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
