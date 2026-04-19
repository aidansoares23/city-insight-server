// test/utils.cityStats.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Mock firebase and timestamps before requiring cityStats
function setMock(relPath, exportsValue) {
  const absPath = path.join(__dirname, "..", relPath);
  const resolved = require.resolve(absPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}

setMock("src/config/firebase.js", {
  db: {},
  admin: { firestore: { FieldValue: { serverTimestamp: () => "server-ts" } } },
});
setMock("src/utils/timestamps.js", {
  updatedTimestamp: () => ({ updatedAt: "server-ts" }),
  serverTimestamps: () => ({ createdAt: "server-ts", updatedAt: "server-ts" }),
});

const {
  normalizeRatings,
  addRatings,
  subRatings,
  computeAverages,
  computeAveragesFromStats,
  assertSumsNonNegative,
  normalizeFlatCityMetrics,
  computeLivabilityV0,
  computeLivabilityV1,
  computeLivabilityNorms,
} = require("../src/utils/cityStats");

const ALL_KEYS = ["safety", "affordability", "walkability", "cleanliness", "overall"];
const VALID_SUMS = { safety: 7, affordability: 5, walkability: 4, cleanliness: 8, overall: 6 };

// ─── normalizeRatings ─────────────────────────────────────────────────────────

test("normalizeRatings: preserves valid numeric values", () => {
  const result = normalizeRatings(VALID_SUMS);
  for (const k of ALL_KEYS) assert.equal(result[k], VALID_SUMS[k]);
});

test("normalizeRatings: missing keys become 0", () => {
  const result = normalizeRatings({});
  for (const k of ALL_KEYS) assert.equal(result[k], 0);
});

test("normalizeRatings: null/NaN values become 0", () => {
  const result = normalizeRatings({ safety: null, affordability: NaN, walkability: undefined });
  assert.equal(result.safety, 0);
  assert.equal(result.affordability, 0);
  assert.equal(result.walkability, 0);
});

test("normalizeRatings: non-object input returns all zeros", () => {
  const result = normalizeRatings(null);
  for (const k of ALL_KEYS) assert.equal(result[k], 0);
});

// ─── addRatings / subRatings ──────────────────────────────────────────────────

test("addRatings: sums corresponding keys", () => {
  const a = { safety: 3, affordability: 2, walkability: 1, cleanliness: 4, overall: 5 };
  const b = { safety: 1, affordability: 1, walkability: 1, cleanliness: 1, overall: 1 };
  const result = addRatings(a, b);
  assert.equal(result.safety, 4);
  assert.equal(result.overall, 6);
});

test("subRatings: subtracts corresponding keys", () => {
  const a = { safety: 10, affordability: 8, walkability: 6, cleanliness: 4, overall: 5 };
  const b = { safety: 3, affordability: 2, walkability: 1, cleanliness: 1, overall: 2 };
  const result = subRatings(a, b);
  assert.equal(result.safety, 7);
  assert.equal(result.overall, 3);
});

test("subRatings: missing keys in b treated as 0", () => {
  const result = subRatings(VALID_SUMS, {});
  for (const k of ALL_KEYS) assert.equal(result[k], VALID_SUMS[k]);
});

// ─── computeAverages ─────────────────────────────────────────────────────────

test("computeAverages: divides sums by count", () => {
  const sums = { safety: 14, affordability: 10, walkability: 8, cleanliness: 16, overall: 12 };
  const result = computeAverages(2, sums);
  assert.equal(result.safety, 7);
  assert.equal(result.overall, 6);
});

test("computeAverages: count=0 returns all null", () => {
  const result = computeAverages(0, VALID_SUMS);
  for (const k of ALL_KEYS) assert.equal(result[k], null);
});

test("computeAveragesFromStats: extracts count, sums, averages from stats doc", () => {
  const doc = { count: 2, sums: { safety: 14, affordability: 10, walkability: 8, cleanliness: 16, overall: 12 } };
  const { count, averages } = computeAveragesFromStats(doc);
  assert.equal(count, 2);
  assert.equal(averages.safety, 7);
});

// ─── assertSumsNonNegative ────────────────────────────────────────────────────

test("assertSumsNonNegative: does not throw for non-negative sums", () => {
  assert.doesNotThrow(() => assertSumsNonNegative({ cityId: "city-x", sums: VALID_SUMS }));
});

test("assertSumsNonNegative: throws when a key goes negative", () => {
  const badSums = { ...VALID_SUMS, safety: -0.5 };
  assert.throws(
    () => assertSumsNonNegative({ cityId: "city-x", sums: badSums }),
    (err) => err.message.includes("city-x") && err.message.includes("safety"),
  );
});

test("assertSumsNonNegative: allows values within epsilon", () => {
  const almostZero = { ...VALID_SUMS, affordability: -1e-10 };
  assert.doesNotThrow(() => assertSumsNonNegative({ cityId: "city-x", sums: almostZero }));
});

// ─── normalizeFlatCityMetrics ─────────────────────────────────────────────────

test("normalizeFlatCityMetrics: extracts numeric fields", () => {
  const doc = { medianRent: 2500, population: 800000, safetyScore: 7.5 };
  const result = normalizeFlatCityMetrics("city-x", doc);
  assert.equal(result.cityId, "city-x");
  assert.equal(result.medianRent, 2500);
  assert.equal(result.population, 800000);
  assert.equal(result.safetyScore, 7.5);
});

test("normalizeFlatCityMetrics: legacy 0–100 safetyScore normalized to 0–10", () => {
  const doc = { medianRent: 2000, population: 500000, safetyScore: 75 };
  const result = normalizeFlatCityMetrics("city-x", doc);
  assert.equal(result.safetyScore, 7.5);
});

test("normalizeFlatCityMetrics: non-numeric fields become null", () => {
  const result = normalizeFlatCityMetrics("city-x", { medianRent: "invalid" });
  assert.equal(result.medianRent, null);
  assert.equal(result.safetyScore, null);
  assert.equal(result.population, null);
});

test("normalizeFlatCityMetrics: handles empty/null doc", () => {
  const result = normalizeFlatCityMetrics("city-x", {});
  assert.equal(result.medianRent, null);
  assert.equal(result.safetyScore, null);
});

// ─── computeLivabilityV0 ─────────────────────────────────────────────────────

test("computeLivabilityV0: computes weighted blend of all three signals", () => {
  // reviewScore = round(7/10*100) = 70
  // safetyScore = round(8*10) = 80
  // rentScore = round((1 - 2000/3500)*100) = round(42.86) = 43
  // score = round(70*0.5 + 80*0.35 + 43*0.15) = round(35+28+6.45) = round(69.45) = 69
  const result = computeLivabilityV0({
    averages: { overall: 7 },
    metrics: { safetyScore: 8, medianRent: 2000 },
  });
  assert.equal(result.version, "v0");
  assert.equal(result.score, 69);
});

test("computeLivabilityV0: renormalizes when safety is missing", () => {
  // safetyScore undefined → NaN → excluded. review (0.5) + rent (0.15) → totalWeight = 0.65
  // reviewScore = round(8/10*100) = 80
  // rentScore = round((1 - 1750/3500)*100) = round(50) = 50
  // score = round(80 * (0.5/0.65) + 50 * (0.15/0.65)) = round(61.54 + 11.54) = 73
  const result = computeLivabilityV0({
    averages: { overall: 8 },
    metrics: { medianRent: 1750 }, // safetyScore absent (undefined)
  });
  assert.equal(result.version, "v0");
  assert.equal(result.score, 73);
});

test("computeLivabilityV0: renormalizes when rent is missing", () => {
  // review (0.5) + safety (0.35) → totalWeight = 0.85
  // reviewScore = 80, safetyScore = 60
  // score = round(80 * (0.5/0.85) + 60 * (0.35/0.85)) = round(47.06 + 24.71) = 72
  const result = computeLivabilityV0({
    averages: { overall: 8 },
    metrics: { safetyScore: 6, medianRent: null },
  });
  assert.equal(result.score, 72);
});

test("computeLivabilityV0: only review signal → score equals review conversion", () => {
  // safetyScore and medianRent absent → both filtered out, only review remains
  // reviewScore = round(5/10*100) = 50 → score = 50
  const result = computeLivabilityV0({
    averages: { overall: 5 },
    metrics: {}, // no safety, no rent
  });
  assert.equal(result.score, 50);
});

test("computeLivabilityV0: all signals null → score is null", () => {
  const result = computeLivabilityV0({ averages: {}, metrics: {} });
  assert.equal(result.version, "v0");
  assert.equal(result.score, null);
});

test("computeLivabilityV0: perfect scores → 100", () => {
  const result = computeLivabilityV0({
    averages: { overall: 10 },
    metrics: { safetyScore: 10, medianRent: 0 },
  });
  assert.equal(result.score, 100);
});

test("computeLivabilityV0: rent above ceiling clamped to 0", () => {
  // rent > RENT_MAX (3500) → rentScore = 0 (clamped, but still included)
  // safetyScore absent → excluded. review(0.5) + rent(0.15) → totalWeight = 0.65
  // score = round(50 * (0.5/0.65) + 0 * (0.15/0.65)) = round(38.46) = 38
  const result = computeLivabilityV0({
    averages: { overall: 5 },
    metrics: { medianRent: 5000 }, // safetyScore absent
  });
  assert.equal(result.score, 38);
});

// ─── computeLivabilityV1 ─────────────────────────────────────────────────────

// Norms used across v1 tests: review 4–8, safety 5–9, rent $1,000–$3,000
const TEST_NORMS = {
  reviewOverall: { min: 4, max: 8 },
  safetyScore:   { min: 5, max: 9 },
  medianRent:    { min: 1000, max: 3000 },
};

test("computeLivabilityV1: top-of-range inputs → 100", () => {
  // overallAvg=8 → reviewScore=100, safety=9 → safetyScore=100, rent=$1000 → rentScore=100
  const result = computeLivabilityV1({
    averages: { overall: 8 },
    metrics: { safetyScore: 9, medianRent: 1000 },
    norms: TEST_NORMS,
  });
  assert.equal(result.version, "v1");
  assert.equal(result.score, 100);
});

test("computeLivabilityV1: bottom-of-range inputs → 0", () => {
  // overallAvg=4 → 0, safety=5 → 0, rent=$3000 → 0
  const result = computeLivabilityV1({
    averages: { overall: 4 },
    metrics: { safetyScore: 5, medianRent: 3000 },
    norms: TEST_NORMS,
  });
  assert.equal(result.score, 0);
});

test("computeLivabilityV1: midpoint inputs → 50", () => {
  // overallAvg=6 → 50, safety=7 → 50, rent=$2000 → 50
  // all signals = 50, blend = 50
  const result = computeLivabilityV1({
    averages: { overall: 6 },
    metrics: { safetyScore: 7, medianRent: 2000 },
    norms: TEST_NORMS,
  });
  assert.equal(result.score, 50);
});

test("computeLivabilityV1: renormalizes when safety norm is absent", () => {
  // safety norm missing → signal dropped. review(0.5) + rent(0.15) → totalWeight=0.65
  // reviewScore = (6-4)/(8-4)*100 = 50, rentScore = (3000-2000)/(3000-1000)*100 = 50
  // score = round(50*(0.5/0.65) + 50*(0.15/0.65)) = round(50) = 50
  const result = computeLivabilityV1({
    averages: { overall: 6 },
    metrics: { safetyScore: 7, medianRent: 2000 },
    norms: { reviewOverall: { min: 4, max: 8 }, medianRent: { min: 1000, max: 3000 } },
  });
  assert.equal(result.score, 50);
});

test("computeLivabilityV1: returns null when no norms are present for any signal", () => {
  const result = computeLivabilityV1({
    averages: { overall: 6 },
    metrics: { safetyScore: 7, medianRent: 2000 },
    norms: {},
  });
  assert.equal(result.version, "v1");
  assert.equal(result.score, null);
});

test("computeLivabilityV1: returns null when averages and metrics are empty", () => {
  const result = computeLivabilityV1({ averages: {}, metrics: {}, norms: TEST_NORMS });
  assert.equal(result.score, null);
});

// ─── computeLivabilityNorms ───────────────────────────────────────────────────

test("computeLivabilityNorms: extracts min/max from city data", () => {
  const cityDataList = [
    { averages: { overall: 4 }, metrics: { safetyScore: 5, medianRent: 1000 } },
    { averages: { overall: 6 }, metrics: { safetyScore: 7, medianRent: 2000 } },
    { averages: { overall: 8 }, metrics: { safetyScore: 9, medianRent: 3000 } },
  ];
  const norms = computeLivabilityNorms(cityDataList);
  assert.equal(norms.reviewOverall.min, 4);
  assert.equal(norms.reviewOverall.max, 8);
  assert.equal(norms.reviewOverall.count, 3);
  assert.equal(norms.safetyScore.min, 5);
  assert.equal(norms.safetyScore.max, 9);
  assert.equal(norms.medianRent.min, 1000);
  assert.equal(norms.medianRent.max, 3000);
});

test("computeLivabilityNorms: returns null for signals with fewer than 2 data points", () => {
  // Only 1 city with a review → degenerate range, can't rank
  const cityDataList = [
    { averages: { overall: 6 }, metrics: { safetyScore: 7, medianRent: null } },
    { averages: {},              metrics: { safetyScore: 8, medianRent: null } },
  ];
  const norms = computeLivabilityNorms(cityDataList);
  assert.equal(norms.reviewOverall, null);     // only 1 review value → null
  assert.equal(norms.medianRent, null);        // no rent values → null
  assert.notEqual(norms.safetyScore, null);    // 2 safety values → valid
  assert.equal(norms.safetyScore.count, 2);
});

test("computeLivabilityNorms: skips cities with missing/null metrics", () => {
  const cityDataList = [
    { averages: { overall: 5 }, metrics: { safetyScore: null, medianRent: 1500 } },
    { averages: { overall: 7 }, metrics: { safetyScore: 8,    medianRent: 2500 } },
  ];
  const norms = computeLivabilityNorms(cityDataList);
  assert.equal(norms.reviewOverall.count, 2);
  assert.equal(norms.safetyScore, null);       // only 1 valid safety value → null
  assert.equal(norms.medianRent.count, 2);
});
