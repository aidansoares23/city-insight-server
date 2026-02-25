// src/services/meService.js
const { db } = require("../config/firebase");
const { serverTimestamps, updatedTimestamp } = require("../utils/timestamps");

async function upsertMeFromAuthClaims(userClaims) {
  const sub = userClaims?.sub;
  if (!sub) {
    const err = new Error("Missing user identity");
    err.status = 401;
    err.code = "UNAUTHENTICATED";
    throw err;
  }

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
  if (!uid) {
    const err = new Error("Missing user identity");
    err.status = 401;
    err.code = "UNAUTHENTICATED";
    throw err;
  }

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
      cityId: data.cityId,
      ratings: data.ratings,
      comment: data.comment ?? null,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  });
}

module.exports = { upsertMeFromAuthClaims, listMyReviews };
