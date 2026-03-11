const { db } = require("../config/firebase");
const { serverTimestamps, updatedTimestamp } = require("../utils/timestamps");
const { tsToIso } = require("../lib/firestore");
const { deleteMyReviewForCity } = require("./reviewService");
const { AppError } = require("../lib/errors");

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

async function deleteAccount({ userId }) {
  const uid = String(userId || "").trim();
  if (!uid) throw new AppError("Missing user identity", { status: 401, code: "UNAUTHENTICATED" });

  const reviews = await listMyReviews({ userId: uid, limit: 100 });

  for (const review of reviews) {
    if (review.cityId) {
      await deleteMyReviewForCity({ cityId: review.cityId, userId: uid });
    }
  }

  await db.collection("users").doc(uid).delete();

  return { deleted: true };
}

module.exports = { upsertMeFromAuthClaims, listMyReviews, deleteAccount };
