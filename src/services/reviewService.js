// src/services/reviewService.js
const { db, admin } = require("../config/firebase");
const { serverTimestamps, updatedTimestamp } = require("../utils/timestamps");
const {
  normalizeRatings,
  addRatings,
  subRatings,
  computeLivabilityV0,
} = require("../utils/cityStats");

const { REQUIRED_RATING_KEYS, makeReviewId } = require("../lib/reviews");
const { isPlainObject } = require("../lib/objects");

function assertSumsNonNegative({ cityId, sums, epsilon = 1e-6 }) {
  for (const k of REQUIRED_RATING_KEYS) {
    const v = Number(sums?.[k] ?? 0);
    if (Number.isFinite(v) && v < -epsilon) {
      throw new Error(
        `city_stats sums went negative for ${cityId}.${k} (${v})`,
      );
    }
  }
}

function computeAveragesFromCountSums(count, sums) {
  const c = Number.isFinite(Number(count)) ? Number(count) : 0;
  const s = normalizeRatings(sums);
  const averages = {};
  for (const k of REQUIRED_RATING_KEYS) {
    averages[k] = c > 0 ? s[k] / c : null;
  }
  return { count: c, sums: s, averages };
}

function normalizeMetricsForLivability(cityId, metricsDoc) {
  const m = isPlainObject(metricsDoc) ? metricsDoc : {};

  // Back-compat: support either medianRent or medianGrossRent.
  const medianRent = Number.isFinite(Number(m.medianRent))
    ? Number(m.medianRent)
    : Number.isFinite(Number(m.medianGrossRent))
      ? Number(m.medianGrossRent)
      : null;

  const raw = Number.isFinite(Number(m.safetyScore))
    ? Number(m.safetyScore)
    : null;
  const safetyScore =
    raw == null ? null : Math.max(0, Math.min(10, raw > 10 ? raw / 10 : raw));

  return {
    cityId,
    medianRent,
    population: Number.isFinite(Number(m.population))
      ? Number(m.population)
      : null,
    safetyScore,
  };

  // return {
  //   cityId,
  //   medianRent,
  //   population: Number.isFinite(Number(m.population))
  //     ? Number(m.population)
  //     : null,
  //   safetyScore: Number.isFinite(Number(m.safetyScore))
  //     ? Number(m.safetyScore)
  //     : null,
  // };
}

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
      const err = new Error("City not found");
      err.status = 404;
      err.code = "CITY_NOT_FOUND";
      throw err;
    }

    const reviewSnap = await tx.get(reviewRef);
    const isNew = !reviewSnap.exists;
    const prevRatingsRaw = reviewSnap.exists
      ? (reviewSnap.data() || {}).ratings
      : null;
    const prevRatings = normalizeRatings(prevRatingsRaw);

    const [statsSnap, metricsSnap] = await Promise.all([
      tx.get(statsRef),
      tx.get(metricsRef),
    ]);

    const prevStats = statsSnap.exists ? statsSnap.data() || {} : {};
    const prevCount = Number(prevStats.count ?? 0);
    const prevSums = normalizeRatings(prevStats.sums);

    const deltaCount = isNew ? 1 : 0;
    const deltaRatings = isNew
      ? normalizeRatings(incomingRatings)
      : subRatings(normalizeRatings(incomingRatings), prevRatings);

    const nextCount = Math.max(0, prevCount + deltaCount);
    const nextSums = addRatings(prevSums, deltaRatings);

    assertSumsNonNegative({ cityId, sums: nextSums });

    const { averages } = computeAveragesFromCountSums(nextCount, nextSums);

    const metricsDoc = metricsSnap.exists ? metricsSnap.data() || {} : {};
    const metrics = normalizeMetricsForLivability(cityId, metricsDoc);
    const livability = computeLivabilityV0({ averages, metrics });

    const reviewPatch = {
      userId: cleanUserId,
      cityId,
      ratings: incomingRatings,
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

    return { isNew, reviewId };
  });

  const savedSnap = await db.collection("reviews").doc(reviewId).get();
  return {
    created: txResult.isNew,
    reviewId,
    review: savedSnap.data() || null,
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
      const err = new Error("City not found");
      err.status = 404;
      err.code = "CITY_NOT_FOUND";
      throw err;
    }

    const reviewSnap = await tx.get(reviewRef);
    if (!reviewSnap.exists) {
      const err = new Error("Review not found");
      err.status = 404;
      err.code = "NOT_FOUND";
      throw err;
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

    const { averages } = computeAveragesFromCountSums(nextCount, nextSums);

    const metricsDoc = metricsSnap.exists ? metricsSnap.data() || {} : {};
    const metrics = normalizeMetricsForLivability(cityId, metricsDoc);
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
