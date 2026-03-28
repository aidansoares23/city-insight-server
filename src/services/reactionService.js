const { db } = require("../config/firebase");
const { serverTimestamps, updatedTimestamp } = require("../utils/timestamps");

const COLLECTION = "review_reactions";

/** Returns the deterministic Firestore document ID for a user + review reaction. */
function reactionDocId(userId, reviewId) {
  return `${userId}:${reviewId}`;
}

/**
 * Creates or replaces the authenticated user's reaction on a review.
 * If they previously reacted with a different type, it is overwritten.
 */
async function upsertReaction({ userId, reviewId, cityId, type }) {
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
 * Returns reaction counts for a review in the shape `{ helpful, agree, disagree }`.
 * Uses a collection-group query filtered to the given reviewId.
 */
async function getReactionCountsForReview({ reviewId }) {
  const snap = await db
    .collection(COLLECTION)
    .where("reviewId", "==", reviewId)
    .get();

  const counts = { helpful: 0, agree: 0, disagree: 0 };
  snap.forEach((doc) => {
    const { type } = doc.data();
    if (type in counts) counts[type]++;
  });
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
  getReactionCountsForReview,
  getMyReactionsForReviews,
};
