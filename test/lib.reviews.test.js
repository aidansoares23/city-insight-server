// test/lib.reviews.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REVIEW_ID_SALT = "test-review-salt";

const {
  makeReviewId,
  validateReviewBody,
  normalizeIncomingRatings,
  normalizeIncomingComment,
} = require("../src/lib/reviews");

const VALID_RATINGS = { safety: 7, cost: 5, traffic: 4, cleanliness: 8, overall: 6 };

// ─── makeReviewId ─────────────────────────────────────────────────────────────

test("makeReviewId: is deterministic", () => {
  assert.equal(makeReviewId("user1", "city-a"), makeReviewId("user1", "city-a"));
});

test("makeReviewId: different inputs produce different IDs", () => {
  assert.notEqual(makeReviewId("user1", "city-a"), makeReviewId("user2", "city-a"));
  assert.notEqual(makeReviewId("user1", "city-a"), makeReviewId("user1", "city-b"));
});

test("makeReviewId: returns 32-character hex string", () => {
  const id = makeReviewId("user1", "city-a");
  assert.equal(id.length, 32);
  assert.match(id, /^[0-9a-f]{32}$/);
});

// ─── validateReviewBody ───────────────────────────────────────────────────────

test("validateReviewBody: valid body passes", () => {
  const result = validateReviewBody({ ratings: VALID_RATINGS });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateReviewBody: valid body with comment passes", () => {
  const result = validateReviewBody({ ratings: VALID_RATINGS, comment: "Great city!" });
  assert.equal(result.ok, true);
});

test("validateReviewBody: null comment is allowed", () => {
  const result = validateReviewBody({ ratings: VALID_RATINGS, comment: null });
  assert.equal(result.ok, true);
});

test("validateReviewBody: rating out of range (0) fails", () => {
  const result = validateReviewBody({ ratings: { ...VALID_RATINGS, safety: 0 } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("safety")));
});

test("validateReviewBody: rating out of range (11) fails", () => {
  const result = validateReviewBody({ ratings: { ...VALID_RATINGS, cost: 11 } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("cost")));
});

test("validateReviewBody: non-integer rating fails", () => {
  const result = validateReviewBody({ ratings: { ...VALID_RATINGS, traffic: 5.5 } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("traffic")));
});

test("validateReviewBody: string rating fails", () => {
  const result = validateReviewBody({ ratings: { ...VALID_RATINGS, overall: "7" } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("overall")));
});

test("validateReviewBody: missing rating key fails", () => {
  const { safety: _omit, ...withoutSafety } = VALID_RATINGS;
  const result = validateReviewBody({ ratings: withoutSafety });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("safety")));
});

test("validateReviewBody: comment over max length fails", () => {
  const result = validateReviewBody({ ratings: VALID_RATINGS, comment: "x".repeat(801) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("comment")));
});

test("validateReviewBody: non-string comment fails", () => {
  const result = validateReviewBody({ ratings: VALID_RATINGS, comment: 42 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("comment")));
});

test("validateReviewBody: non-object body fails", () => {
  const result = validateReviewBody(null);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

// ─── normalizeIncomingRatings ────────────────────────────────────────────────

test("normalizeIncomingRatings: preserves valid integer ratings", () => {
  const result = normalizeIncomingRatings(VALID_RATINGS);
  assert.deepEqual(result, VALID_RATINGS);
});

test("normalizeIncomingRatings: rounds float to nearest integer", () => {
  const result = normalizeIncomingRatings({ ...VALID_RATINGS, safety: 6.7 });
  assert.equal(result.safety, 7);
});

test("normalizeIncomingRatings: missing keys default to 0", () => {
  const result = normalizeIncomingRatings({});
  for (const val of Object.values(result)) assert.equal(val, 0);
});

test("normalizeIncomingRatings: non-numeric values default to 0", () => {
  const result = normalizeIncomingRatings({ ...VALID_RATINGS, cost: "abc" });
  assert.equal(result.cost, 0);
});

// ─── normalizeIncomingComment ────────────────────────────────────────────────

test("normalizeIncomingComment: trims and returns non-empty string", () => {
  const { normalizeIncomingComment: norm } = require("../src/lib/reviews");
  assert.equal(norm("  hello  "), "hello");
  assert.equal(norm("Great!"), "Great!");
});

test("normalizeIncomingComment: returns null for empty/whitespace/null", () => {
  const { normalizeIncomingComment: norm } = require("../src/lib/reviews");
  assert.equal(norm(null), null);
  assert.equal(norm(""), null);
  assert.equal(norm("   "), null);
});
