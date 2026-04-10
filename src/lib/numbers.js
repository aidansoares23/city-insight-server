/** Converts a value to a number; returns `null` if the result is non-finite. */
function toNumOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** Like `toNumOrNull` but also returns `null` for `null`, `undefined`, and blank strings. */
function toOptionalNumOrNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return toNumOrNull(value);
}

/** Converts a value to a number; returns `fallback` (default `NaN`) if the result is non-finite. */
function toFiniteNumber(value, fallback = NaN) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/** Clamps `n` to [0, 10]; returns `null` if `n` is `null`. */
function clamp0to10(n) {
  if (n == null) return null;
  return Math.max(0, Math.min(10, n));
}

/** Rounds and clamps `n` to [0, 100]; returns `null` if `n` is `null`. */
function clamp0to100(n) {
  if (n == null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Converts a median rent value to a 0–100 affordability score via an inverse rent-to-ceiling ratio.
 * A rent equal to `rentMax` yields 0; rent of 0 yields 100. Returns `null` for invalid inputs.
 */
function medianRentToAffordability100(value, rentMax = 3500) {
  if (value == null) return null;
  const rent = toNumOrNull(value);
  const ceiling = toNumOrNull(rentMax);
  if (rent == null || ceiling == null || ceiling <= 0 || rent < 0) return null;
  return clamp0to100((1 - rent / ceiling) * 100);
}

/** Converts median rent to a 0–10 affordability score via the 0–100 scale. Returns `null` for invalid inputs. */
function medianRentToAffordability10(value, rentMax = 3500) {
  const affordability100 = medianRentToAffordability100(value, rentMax);
  if (affordability100 == null) return null;
  return clamp0to10(Math.round(affordability100) / 10);
}

/**
 * Maps `value` linearly from [min, max] to [0–100] where max → 100 (higher is better).
 * Clamped to [0, 100]. Returns `null` for null/undefined/invalid inputs or a degenerate range (max ≤ min).
 */
function rangeScore(value, min, max) {
  const v  = toOptionalNumOrNull(value);
  const lo = toOptionalNumOrNull(min);
  const hi = toOptionalNumOrNull(max);
  if (v == null || lo == null || hi == null || hi <= lo) return null;
  return clamp0to100(((v - lo) / (hi - lo)) * 100);
}

/**
 * Maps `value` linearly from [min, max] to [0–100] where min → 100 (inverted — lower value is better).
 * Clamped to [0, 100]. Returns `null` for null/undefined/invalid inputs or a degenerate range (max ≤ min).
 */
function rangeScoreInverted(value, min, max) {
  const v  = toOptionalNumOrNull(value);
  const lo = toOptionalNumOrNull(min);
  const hi = toOptionalNumOrNull(max);
  if (v == null || lo == null || hi == null || hi <= lo) return null;
  return clamp0to100(((hi - v) / (hi - lo)) * 100);
}

/**
 * Normalizes a safety score to the 0–10 scale.
 * Handles legacy values stored on the 0–100 scale (divides by 10 if > 10).
 * Returns `null` for null/non-finite input.
 */
function normalizeSafetyTo10(value) {
  if (value == null) return null;
  const num = toNumOrNull(value);
  if (num == null) return null;
  const scaled = num > 10 ? num / 10 : num;
  return clamp0to10(Math.round(scaled * 10) / 10);
}

module.exports = {
  toNumOrNull,
  toOptionalNumOrNull,
  toFiniteNumber,
  clamp0to10,
  clamp0to100,
  medianRentToAffordability100,
  medianRentToAffordability10,
  normalizeSafetyTo10,
  rangeScore,
  rangeScoreInverted,
};
