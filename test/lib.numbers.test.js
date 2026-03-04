// test/lib.numbers.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  toNumOrNull,
  toOptionalNumOrNull,
  toFiniteNumber,
  clamp0to10,
  clamp0to100,
  normalizeSafetyTo10,
} = require("../src/lib/numbers");

// ─── toNumOrNull ──────────────────────────────────────────────────────────────

test("toNumOrNull: returns numeric value for valid inputs", () => {
  assert.equal(toNumOrNull(5), 5);
  assert.equal(toNumOrNull(-3.14), -3.14);
  assert.equal(toNumOrNull("42"), 42);
  assert.equal(toNumOrNull(0), 0);
});

test("toNumOrNull: returns null for non-finite inputs", () => {
  assert.equal(toNumOrNull(undefined), null);
  assert.equal(toNumOrNull(NaN), null);
  assert.equal(toNumOrNull(Infinity), null);
  assert.equal(toNumOrNull(-Infinity), null);
  assert.equal(toNumOrNull("abc"), null);
});

// ─── toOptionalNumOrNull ─────────────────────────────────────────────────────

test("toOptionalNumOrNull: returns null for nullish/blank inputs", () => {
  assert.equal(toOptionalNumOrNull(null), null);
  assert.equal(toOptionalNumOrNull(undefined), null);
  assert.equal(toOptionalNumOrNull(""), null);
  assert.equal(toOptionalNumOrNull("   "), null);
});

test("toOptionalNumOrNull: returns numeric value for valid inputs", () => {
  assert.equal(toOptionalNumOrNull("42"), 42);
  assert.equal(toOptionalNumOrNull(0), 0);
  assert.equal(toOptionalNumOrNull("-7.5"), -7.5);
});

// ─── toFiniteNumber ───────────────────────────────────────────────────────────

test("toFiniteNumber: returns number for finite inputs", () => {
  assert.equal(toFiniteNumber(7), 7);
  assert.equal(toFiniteNumber("3.5"), 3.5);
  assert.equal(toFiniteNumber(0), 0);
});

test("toFiniteNumber: returns NaN fallback by default for non-finite", () => {
  assert.ok(Number.isNaN(toFiniteNumber(undefined)));
  assert.ok(Number.isNaN(toFiniteNumber("abc")));
  // Number(null) === 0 which IS finite, so null returns 0 rather than the fallback
  assert.equal(toFiniteNumber(null), 0);
});

test("toFiniteNumber: returns custom fallback for non-finite", () => {
  assert.equal(toFiniteNumber(undefined, 0), 0);
  assert.equal(toFiniteNumber("abc", -1), -1);
});

// ─── clamp0to10 ───────────────────────────────────────────────────────────────

test("clamp0to10: passthrough for values in range", () => {
  assert.equal(clamp0to10(0), 0);
  assert.equal(clamp0to10(5), 5);
  assert.equal(clamp0to10(10), 10);
  assert.equal(clamp0to10(7.5), 7.5);
});

test("clamp0to10: clamps below 0", () => {
  assert.equal(clamp0to10(-1), 0);
  assert.equal(clamp0to10(-100), 0);
});

test("clamp0to10: clamps above 10", () => {
  assert.equal(clamp0to10(11), 10);
  assert.equal(clamp0to10(100), 10);
});

test("clamp0to10: returns null for null input", () => {
  assert.equal(clamp0to10(null), null);
  assert.equal(clamp0to10(undefined), null);
});

// ─── clamp0to100 ─────────────────────────────────────────────────────────────

test("clamp0to100: rounds and clamps values", () => {
  assert.equal(clamp0to100(0), 0);
  assert.equal(clamp0to100(100), 100);
  assert.equal(clamp0to100(50.6), 51);
  assert.equal(clamp0to100(-5), 0);
  assert.equal(clamp0to100(105), 100);
});

test("clamp0to100: returns null for null input", () => {
  assert.equal(clamp0to100(null), null);
  assert.equal(clamp0to100(undefined), null);
});

// ─── normalizeSafetyTo10 ─────────────────────────────────────────────────────

test("normalizeSafetyTo10: passthrough for 0–10 scale values", () => {
  assert.equal(normalizeSafetyTo10(0), 0);
  assert.equal(normalizeSafetyTo10(10), 10);
  assert.equal(normalizeSafetyTo10(7), 7);
  assert.equal(normalizeSafetyTo10(6.5), 6.5);
});

test("normalizeSafetyTo10: divides by 10 for legacy 0–100 scale values", () => {
  assert.equal(normalizeSafetyTo10(85), 8.5);
  assert.equal(normalizeSafetyTo10(100), 10);
  assert.equal(normalizeSafetyTo10(0), 0);
});

test("normalizeSafetyTo10: returns null for non-numeric inputs", () => {
  assert.equal(normalizeSafetyTo10(null), null);
  assert.equal(normalizeSafetyTo10(undefined), null);
  assert.equal(normalizeSafetyTo10("abc"), null);
  assert.equal(normalizeSafetyTo10(NaN), null);
});

test("normalizeSafetyTo10: clamps out-of-range values", () => {
  assert.equal(normalizeSafetyTo10(-5), 0);   // below 0 → 0
  assert.equal(normalizeSafetyTo10(150), 10); // legacy 0-100, 150/10=15 → clamped to 10
});
