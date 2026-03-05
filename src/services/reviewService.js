// src/services/reviewService.js
const { db, admin } = require("../config/firebase");
const { serverTimestamps, updatedTimestamp } = require("../utils/timestamps");
const {
  normalizeRatings,
  addRatings,
  subRatings,
  assertSumsNonNegative,
  computeAverages,
  normalizeFlatCityMetrics,
  computeLivabilityV0,
} = require("../utils/cityStats");

const { makeReviewId } = require("../lib/reviews");
const { AppError } = require("../lib/errors");

/**
 * Transaction: create/update "my review" + update city_stats (count/sums/livability)
 */
async function upsertMyReviewForCity({
  cityId,
  userId,
  incomingRatings,
  incomingComment,
}) {
  const cleanUserId = String(userId).trim();
  const reviewId = makeReviewId(cleanUserId, cityId);

  const cityRef = db.collection("cities").doc(cityId);
  const reviewRef = db.collection("reviews").doc(reviewId);
  const statsRef = db.collection("city_stats").doc(cityId);
  const metricsRef = db.collection("city_metrics").doc(cityId);

  const txResult = await db.runTransaction(async (tx) => {
    const citySnap = await tx.get(cityRef);
    if (!citySnap.exists) {
      throw new AppError("City not found", { status: 404, code: "CITY_NOT_FOUND" });
    }

    const reviewSnap = await tx.get(reviewRef);
    const isNew = !reviewSnap.exists;
    const prevData = reviewSnap.exists ? reviewSnap.data() || {} : {};
    const prevRatings = normalizeRatings(prevData.ratings);

    const [statsSnap, metricsSnap] = await Promise.all([
      tx.get(statsRef),
      tx.get(metricsRef),
    ]);

    const prevStats = statsSnap.exists ? statsSnap.data() || {} : {};
    const prevCount = Number(prevStats.count ?? 0);
    const prevSums = normalizeRatings(prevStats.sums);

    const normalizedRatings = normalizeRatings(incomingRatings);
    const deltaCount = isNew ? 1 : 0;
    const deltaRatings = isNew
      ? normalizedRatings
      : subRatings(normalizedRatings, prevRatings);

    const nextCount = Math.max(0, prevCount + deltaCount);
    const nextSums = addRatings(prevSums, deltaRatings);

    assertSumsNonNegative({ cityId, sums: nextSums });

    const averages = computeAverages(nextCount, nextSums);

    const metricsDoc = metricsSnap.exists ? metricsSnap.data() || {} : {};
    const metrics = normalizeFlatCityMetrics(cityId, metricsDoc);
    const livability = computeLivabilityV0({ averages, metrics });

    const now = admin.firestore.Timestamp.fromDate(new Date());
    const reviewPatch = {
      userId: cleanUserId,
      cityId,
      ratings: normalizedRatings,
      comment: incomingComment,
      ...(isNew ? serverTimestamps() : updatedTimestamp()),
    };
    tx.set(reviewRef, reviewPatch, { merge: true });

    const statsPatch = {
      cityId,
      count: nextCount,
      sums: nextSums,
      livability,
      ...updatedTimestamp(),
    };
    tx.set(statsRef, statsPatch, { merge: true });

    // Build response data with a local timestamp to avoid a post-transaction read.
    // createdAt is preserved from the existing doc on updates.
    const reviewData = {
      userId: cleanUserId,
      cityId,
      ratings: normalizedRatings,
      comment: incomingComment,
      createdAt: isNew ? now : (prevData.createdAt ?? now),
      updatedAt: now,
    };

    return { isNew, reviewData };
  });

  return {
    created: txResult.isNew,
    reviewId,
    review: txResult.reviewData,
  };
}

async function getMyReviewForCity({ cityId, userId }) {
  const reviewId = makeReviewId(String(userId).trim(), cityId);
  const snap = await db.collection("reviews").doc(reviewId).get();
  return snap.exists
    ? { reviewId, review: snap.data() }
    : { reviewId, review: null };
}

async function deleteMyReviewForCity({ cityId, userId }) {
  const reviewId = makeReviewId(String(userId).trim(), cityId);

  const cityRef = db.collection("cities").doc(cityId);
  const reviewRef = db.collection("reviews").doc(reviewId);
  const statsRef = db.collection("city_stats").doc(cityId);
  const metricsRef = db.collection("city_metrics").doc(cityId);

  await db.runTransaction(async (tx) => {
    const citySnap = await tx.get(cityRef);
    if (!citySnap.exists) {
      throw new AppError("City not found", { status: 404, code: "CITY_NOT_FOUND" });
    }

    const reviewSnap = await tx.get(reviewRef);
    if (!reviewSnap.exists) {
      throw new AppError("Review not found", { status: 404, code: "NOT_FOUND" });
    }

    const existing = reviewSnap.data() || {};
    const oldRatings = normalizeRatings(existing.ratings || {});

    const [statsSnap, metricsSnap] = await Promise.all([
      tx.get(statsRef),
      tx.get(metricsRef),
    ]);

    const prevStats = statsSnap.exists ? statsSnap.data() || {} : {};
    const prevCount = Number(prevStats.count ?? 0);
    const prevSums = normalizeRatings(prevStats.sums);

    const nextCount = Math.max(0, prevCount - 1);
    const nextSums = addRatings(prevSums, subRatings({}, oldRatings));

    assertSumsNonNegative({ cityId, sums: nextSums });

    const averages = computeAverages(nextCount, nextSums);

    const metricsDoc = metricsSnap.exists ? metricsSnap.data() || {} : {};
    const metrics = normalizeFlatCityMetrics(cityId, metricsDoc);
    const livability = computeLivabilityV0({ averages, metrics });

    tx.delete(reviewRef);

    tx.set(
      statsRef,
      {
        cityId,
        count: nextCount,
        sums: nextSums,
        livability,
        ...updatedTimestamp(),
      },
      { merge: true },
    );
  });

  return { deleted: true };
}

async function listReviewsForCity({ cityId, pageSize, cursor }) {
  let query = db
    .collection("reviews")
    .where("cityId", "==", cityId)
    .orderBy("createdAt", "desc")
    .orderBy(admin.firestore.FieldPath.documentId(), "desc")
    .limit(pageSize);

  if (cursor?.id && !cursor?.createdAt) {
    throw new AppError("Malformed cursor: id requires createdAt", { status: 400, code: "BAD_CURSOR" });
  }

  // Preferred cursor: (createdAt, id)
  if (cursor?.id && cursor?.createdAt) {
    query = query.startAfter(cursor.createdAt, cursor.id);
  }

  // Back-compat cursor: after=<docId>
  if (!cursor?.id && cursor?.afterIdOnly) {
    const afterSnap = await db
      .collection("reviews")
      .doc(cursor.afterIdOnly)
      .get();
    if (afterSnap.exists) {
      const afterData = afterSnap.data() || {};
      if (afterData.cityId === cityId && afterData.createdAt) {
        query = query.startAfter(afterData.createdAt, afterSnap.id);
      }
    }
  }

  const snap = await query.get();
  return snap.docs;
}

async function getReviewByIdForCity({ cityId, reviewId }) {
  const snap = await db.collection("reviews").doc(reviewId).get();
  if (!snap.exists) return null;

  const data = snap.data() || {};
  if (data.cityId !== cityId) return null;

  return { id: snap.id, data };
}

module.exports = {
  upsertMyReviewForCity,
  getMyReviewForCity,
  deleteMyReviewForCity,
  listReviewsForCity,
  getReviewByIdForCity,
};
