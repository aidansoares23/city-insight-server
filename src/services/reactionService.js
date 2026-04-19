const { db } = require("../config/firebase");
const { serverTimestamps, updatedTimestamp } = require("../utils/timestamps");
const { AppError } = require("../lib/errors");

const COLLECTION = "review_reactions";

/** Returns the deterministic Firestore document ID for a user + review reaction. */
function reactionDocId(userId, reviewId) {
  return `${userId}:${reviewId}`;
}

/**
 * Creates or replaces the authenticated user's reaction on a review.
 * Validates that the review exists, belongs to the given city, and was not written by this user.
 * Throws AppError 404 if not found, 403 if the user tries to react to their own review.
 * If they previously reacted with a different type, the reaction is overwritten.
 */
async function upsertReaction({ userId, reviewId, cityId, type }) {
  // Validate review existence, city ownership, and self-reaction guard
  const reviewSnap = await db.collection("reviews").doc(reviewId).get();
  if (!reviewSnap.exists) {
    throw new AppError("Review not found", { status: 404, code: "NOT_FOUND" });
  }
  const reviewData = reviewSnap.data();
  if (reviewData.cityId !== cityId) {
    throw new AppError("Review not found for this city", { status: 404, code: "NOT_FOUND" });
  }
  if (reviewData.userId === userId) {
    throw new AppError("You cannot react to your own review", { status: 403, code: "CANNOT_REACT_TO_OWN_REVIEW" });
  }

  const docId = reactionDocId(userId, reviewId);
  const ref = db.collection(COLLECTION).doc(docId);

  const snap = await ref.get();
  if (snap.exists) {
    await ref.set(
      { userId, reviewId, cityId, type, ...updatedTimestamp() },
      { merge: true },
    );
  } else {
    await ref.set({
      userId,
      reviewId,
      cityId,
      type,
      ...serverTimestamps(),
    });
  }
}

/** Removes the authenticated user's reaction on a review, if it exists. */
async function deleteReaction({ userId, reviewId }) {
  const docId = reactionDocId(userId, reviewId);
  await db.collection(COLLECTION).doc(docId).delete();
}

/** Returns the reaction type the user has on a review, or `null` if none. */
async function getMyReaction({ userId, reviewId }) {
  const docId = reactionDocId(userId, reviewId);
  const snap = await db.collection(COLLECTION).doc(docId).get();
  return snap.exists ? snap.data().type : null;
}

/**
 * Returns reaction counts for every review in the list in a single query.
 * Returns a Map<reviewId, { helpful, agree, disagree }>.
 * Firestore `in` supports up to 30 values; the list is chunked accordingly.
 */
async function getReactionCountsForReviews(reviewIds) {
  if (!reviewIds.length) return new Map();

  const chunks = [];
  for (let i = 0; i < reviewIds.length; i += 30) chunks.push(reviewIds.slice(i, i + 30));

  const snaps = await Promise.all(
    chunks.map((chunk) => db.collection(COLLECTION).where("reviewId", "in", chunk).get()),
  );

  const counts = new Map();
  for (const snap of snaps) {
    snap.forEach((doc) => {
      const { reviewId, type } = doc.data();
      if (!counts.has(reviewId)) counts.set(reviewId, { helpful: 0, agree: 0, disagree: 0 });
      const entry = counts.get(reviewId);
      if (type in entry) entry[type]++;
    });
  }
  return counts;
}

/**
 * Batch-fetches the current user's reactions for a list of review IDs.
 * Returns a Map<reviewId, type|null>.
 * Uses `db.getAll()` — a single RPC regardless of list length.
 */
async function getMyReactionsForReviews({ userId, reviewIds }) {
  if (!reviewIds.length) return new Map();

  const refs = reviewIds.map((reviewId) =>
    db.collection(COLLECTION).doc(reactionDocId(userId, reviewId)),
  );

  const snaps = await db.getAll(...refs);
  const result = new Map();
  snaps.forEach((snap) => {
    if (!snap.exists) return;
    const { reviewId, type } = snap.data();
    result.set(reviewId, type);
  });
  return result;
}

module.exports = {
  upsertReaction,
  deleteReaction,
  getMyReaction,
  getReactionCountsForReviews,
  getMyReactionsForReviews,
};
