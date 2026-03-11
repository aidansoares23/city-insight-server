const crypto = require("crypto");
const { isPlainObject } = require("./objects");

const REQUIRED_RATING_KEYS = [
  "safety",
  "affordability",
  "walkability",
  "cleanliness",
  "overall",
];
const MAX_COMMENT_LEN = 800;

function makeReviewId(userId, cityId) {
  const salt = process.env.REVIEW_ID_SALT;
  if (!salt) throw new Error("Missing REVIEW_ID_SALT in env");

  return crypto
    .createHash("sha256")
    .update(`${userId}:${cityId}:${salt}`)
    .digest("hex")
    .slice(0, 32);
}

function validateRatings(ratings) {
  const errors = [];
  if (!isPlainObject(ratings)) return ["ratings is required (object)"];

  for (const key of REQUIRED_RATING_KEYS) {
    const rating = ratings[key];

    if (typeof rating !== "number" || !Number.isFinite(rating)) {
      errors.push(`ratings.${key} must be a finite number`);
      continue;
    }
    if (!Number.isInteger(rating))
      errors.push(`ratings.${key} must be an integer`);
    if (rating < 1 || rating > 10)
      errors.push(`ratings.${key} must be between 1 and 10`);
  }
  return errors;
}

function validateReviewBody(body) {
  const errors = [];
  if (!isPlainObject(body)) {
    return { ok: false, errors: ["Body must be an object"] };
  }

  errors.push(...validateRatings(body.ratings));

  if (body.comment != null) {
    if (typeof body.comment !== "string") {
      errors.push("comment must be a string or null");
    } else if (body.comment.length > MAX_COMMENT_LEN) {
      errors.push(`comment must be <= ${MAX_COMMENT_LEN} chars`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function normalizeIncomingRatings(ratings) {
  const normalized = {};
  for (const key of REQUIRED_RATING_KEYS) {
    normalized[key] = Number.isFinite(Number(ratings?.[key]))
      ? Math.round(Number(ratings[key]))
      : 0;
  }
  return normalized;
}

function normalizeIncomingComment(comment) {
  if (comment == null) return null;
  const trimmed = String(comment).trim();
  return trimmed ? trimmed : null;
}

module.exports = {
  REQUIRED_RATING_KEYS,
  MAX_COMMENT_LEN,
  makeReviewId,
  validateReviewBody,
  normalizeIncomingRatings,
  normalizeIncomingComment,
};
