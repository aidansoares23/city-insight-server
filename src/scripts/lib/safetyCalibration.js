/**
 * Shared safety-score calibration constants and formula.
 * Used by both the CSV-based (safety.js) and FBI API-based (safetyApi.js) pipelines
 * to ensure consistent score output regardless of data source.
 */

const { clamp0to10 } = require("../../lib/numbers");

/** Number of most-recent years to average when computing crime rates. */
const YEARS_TO_AVG = 3;

/** Weight applied to violent crime rate in the blended index formula. */
const WEIGHT_VIOLENT = 3;

/** Weight applied to property crime rate in the blended index formula. */
const WEIGHT_PROPERTY = 1;

/**
 * Weighted-average crime index (per 100k population) that maps to safetyScore = 0.
 * Calibrated so a high-crime city (violent ≈ 750, property ≈ 2500 per 100k) scores ~5.3
 * and the US national average (violent ≈ 380, property ≈ 2000 per 100k) scores ~6.9.
 */
const RATE_AT_ZERO = 2500;

/**
 * Converts a blended crime index (per 100k) to a 0–10 safety score.
 * Returns null for non-finite inputs.
 * @param {number} crimeIndexPer100k
 * @returns {number|null}
 */
function computeSafetyScore(crimeIndexPer100k) {
  if (!Number.isFinite(crimeIndexPer100k)) return null;
  const raw = 10 - (crimeIndexPer100k / RATE_AT_ZERO) * 10;
  return Math.round(clamp0to10(raw) * 10) / 10;
}

module.exports = { YEARS_TO_AVG, WEIGHT_VIOLENT, WEIGHT_PROPERTY, RATE_AT_ZERO, computeSafetyScore };
