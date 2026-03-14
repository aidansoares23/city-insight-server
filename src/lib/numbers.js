function toNumOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toOptionalNumOrNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return toNumOrNull(value);
}

function toFiniteNumber(value, fallback = NaN) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp0to10(n) {
  if (n == null) return null;
  return Math.max(0, Math.min(10, n));
}

function clamp0to100(n) {
  if (n == null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function medianRentToAffordability100(value, rentMax = 3500) {
  if (value == null) return null;
  const rent = toNumOrNull(value);
  const ceiling = toNumOrNull(rentMax);
  if (rent == null || ceiling == null || ceiling <= 0 || rent < 0) return null;
  return clamp0to100((1 - rent / ceiling) * 100);
}

function medianRentToAffordability10(value, rentMax = 3500) {
  const affordability100 = medianRentToAffordability100(value, rentMax);
  if (affordability100 == null) return null;
  return clamp0to10(Math.round(affordability100) / 10);
}

// Normalize a safety score to the 0–10 scale.
// Handles legacy values stored on the 0–100 scale (divides by 10 if > 10).
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
};
