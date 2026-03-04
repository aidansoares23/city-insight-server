// src/lib/numbers.js

function toNumOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
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

// Normalize a safety score to the 0–10 scale.
// Handles legacy values stored on the 0–100 scale (divides by 10 if > 10).
function normalizeSafetyTo10(x) {
  if (x == null) return null;
  const n = toNumOrNull(x);
  if (n == null) return null;
  const s = n > 10 ? n / 10 : n;
  return clamp0to10(Math.round(s * 10) / 10);
}

module.exports = { toNumOrNull, toFiniteNumber, clamp0to10, clamp0to100, normalizeSafetyTo10 };
