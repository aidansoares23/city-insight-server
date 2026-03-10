// src/lib/numbers.js

function toNumOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function toOptionalNumOrNull(x) {
  if (x == null) return null;
  if (typeof x === "string" && x.trim() === "") return null;
  return toNumOrNull(x);
}

function toFiniteNumber(x, fallback = NaN) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp0to10(n) {
  if (n == null) return null;
  return Math.max(0, Math.min(10, n));
}

function clamp0to100(n) {
  if (n == null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function medianRentToAffordability100(x, rentMax = 3500) {
  if (x == null) return null;
  const rent = toNumOrNull(x);
  const ceiling = toNumOrNull(rentMax);
  if (rent == null || ceiling == null || ceiling <= 0 || rent < 0) return null;
  return clamp0to100((1 - rent / ceiling) * 100);
}

function medianRentToAffordability10(x, rentMax = 3500) {
  const affordability100 = medianRentToAffordability100(x, rentMax);
  if (affordability100 == null) return null;
  return clamp0to10(Math.round(affordability100) / 10);
}

// Normalize a safety score to the 0–10 scale.
// Handles legacy values stored on the 0–100 scale (divides by 10 if > 10).
function normalizeSafetyTo10(x) {
  if (x == null) return null;
  const n = toNumOrNull(x);
  if (n == null) return null;
  const s = n > 10 ? n / 10 : n;
  return clamp0to10(Math.round(s * 10) / 10);
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
};
