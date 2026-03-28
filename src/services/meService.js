const { db } = require("../config/firebase");
const { serverTimestamps, updatedTimestamp } = require("../utils/timestamps");
const { tsToIso } = require("../lib/firestore");
const { deleteMyReviewForCity } = require("./reviewService");
const { AppError } = require("../lib/errors");

/**
 * Creates or updates the authenticated user's Firestore document from their JWT claims.
 * Sets `createdAt`/`updatedAt` server timestamps on first write; only `updatedAt` on subsequent writes.
 * @param {{ sub: string, email?: string, name?: string, picture?: string }} userClaims
 * @returns {Promise<{ created: boolean, user: object|null, sub: string }>}
 */
async function upsertMeFromAuthClaims(userClaims) {
  const sub = userClaims?.sub;
  if (!sub) throw new AppError("Missing user identity", { status: 401, code: "UNAUTHENTICATED" });

  const userRef = db.collection("users").doc(sub);
  const snap = await userRef.get();

  const base = {
    uid: sub,
    email: userClaims.email || null,
    displayName: userClaims.name || null,
    picture: userClaims.picture || null,
  };

  if (!snap.exists) {
    await userRef.set({ ...base, ...serverTimestamps() }, { merge: true });
  } else {
    await userRef.set({ ...base, ...updatedTimestamp() }, { merge: true });
  }

  const savedSnap = await userRef.get();
  return { created: !snap.exists, user: savedSnap.data() || null, sub };
}

/**
 * Returns up to `limit` reviews authored by `userId`, ordered by most recently updated.
 * @param {{ userId: string, limit?: number }} options - limit capped at 100
 * @returns {Promise<object[]>}
 */
async function listMyReviews({ userId, limit = 50 }) {
  const uid = String(userId || "").trim();
  if (!uid) throw new AppError("Missing user identity", { status: 401, code: "UNAUTHENTICATED" });

  const safeLimit = Math.min(Number(limit) || 50, 100);

  const snap = await db
    .collection("reviews")
    .where("userId", "==", uid)
    .orderBy("updatedAt", "desc")
    .limit(safeLimit)
    .get();

  return snap.docs.map((d) => {
    const data = d.data() || {};
    return {
      id: d.id,
      cityId: data.cityId,
      ratings: data.ratings,
      comment: data.comment ?? null,
      isEdited: data.isEdited ?? false,
      createdAt: tsToIso(data.createdAt),
      updatedAt: tsToIso(data.updatedAt),
    };
  });
}

/**
 * Permanently deletes the user's account and all their reviews.
 * Each review deletion goes through `deleteMyReviewForCity` so city stats are recomputed correctly.
 * @param {{ userId: string }} options
 * @returns {Promise<{ deleted: true }>}
 */
async function deleteAccount({ userId }) {
  const uid = String(userId || "").trim();
  if (!uid) throw new AppError("Missing user identity", { status: 401, code: "UNAUTHENTICATED" });

  const snap = await db.collection("reviews").where("userId", "==", uid).get();

  // Run all review deletions in parallel. Use allSettled so a single failure
  // (e.g. transient network error) does not block the rest or prevent user deletion.
  // NOT_FOUND means the review is already gone — safe to ignore.
  const results = await Promise.allSettled(
    snap.docs
      .map((doc) => doc.data()?.cityId)
      .filter(Boolean)
      .map((cityId) => deleteMyReviewForCity({ cityId, userId: uid })),
  );

  const failures = results.filter(
    (r) => r.status === "rejected" && r.reason?.code !== "NOT_FOUND",
  );
  if (failures.length > 0) {
    console.error(
      `[deleteAccount] ${failures.length} review deletion(s) failed for uid=${uid}:`,
      failures.map((f) => f.reason?.message ?? String(f.reason)),
    );
  }

  // Delete favorites subcollection. Firestore doesn't cascade-delete subcollections,
  // so we must do it explicitly before removing the parent document.
  const favSnap = await db.collection("users").doc(uid).collection("favorites").get();
  await Promise.allSettled(favSnap.docs.map((doc) => doc.ref.delete()));

  // Delete the user document regardless — a partially cleaned up account is
  // far better than a permanently blocked deletion.
  await db.collection("users").doc(uid).delete();

  return { deleted: true };
}

/**
 * Returns all cities favorited by `userId`, ordered by most recently added.
 * @param {{ userId: string }} options
 * @returns {Promise<{ cityId: string, createdAt: string|null }[]>}
 */
async function listMyFavorites({ userId }) {
  const uid = String(userId || "").trim();
  if (!uid) throw new AppError("Missing user identity", { status: 401, code: "UNAUTHENTICATED" });

  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("favorites")
    .orderBy("createdAt", "desc")
    .get();

  return snap.docs.map((d) => ({
    cityId: d.id,
    createdAt: tsToIso(d.data()?.createdAt),
  }));
}

/**
 * Adds a city to the user's favorites (idempotent).
 * @param {{ userId: string, citySlug: string }} options
 * @returns {Promise<{ cityId: string }>}
 */
async function addFavorite({ userId, citySlug }) {
  const uid = String(userId || "").trim();
  const slug = String(citySlug || "").trim();
  if (!uid) throw new AppError("Missing user identity", { status: 401, code: "UNAUTHENTICATED" });
  if (!slug) throw new AppError("Missing city slug", { status: 400, code: "INVALID_INPUT" });

  const ref = db.collection("users").doc(uid).collection("favorites").doc(slug);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ cityId: slug, ...serverTimestamps() });
  }
  return { cityId: slug };
}

/**
 * Removes a city from the user's favorites (idempotent).
 * @param {{ userId: string, citySlug: string }} options
 * @returns {Promise<{ deleted: true }>}
 */
async function removeFavorite({ userId, citySlug }) {
  const uid = String(userId || "").trim();
  const slug = String(citySlug || "").trim();
  if (!uid) throw new AppError("Missing user identity", { status: 401, code: "UNAUTHENTICATED" });
  if (!slug) throw new AppError("Missing city slug", { status: 400, code: "INVALID_INPUT" });

  await db.collection("users").doc(uid).collection("favorites").doc(slug).delete();
  return { deleted: true };
}

module.exports = { upsertMeFromAuthClaims, listMyReviews, deleteAccount, listMyFavorites, addFavorite, removeFavorite };
