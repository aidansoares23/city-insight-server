// src/controllers/meController.js
const { db } = require("../config/firebase");
const { serverTimestamps, updatedTimestamp } = require("../utils/timestamps");

async function getMe(req, res, next) {
  try {
    const sub = req.user.sub;

    const userRef = db.collection("users").doc(sub);
    const snap = await userRef.get();

    const base = {
      uid: sub,
      email: req.user.email || null,
      displayName: req.user.name || null,
      picture: req.user.picture || null,
    };


    if (!snap.exists) {
      // First time we see this user
      await userRef.set(
        {
          ...base,
          ...serverTimestamps(),
        },
        { merge: true }
      );
    } else {
      // Returning user: keep createdAt, update updatedAt
      await userRef.set(
        {
          ...base,
          ...updatedTimestamp(),
        },
        { merge: true }
      );
    }

    // Read back so timestamps are real
    const savedSnap = await userRef.get();
    const saved = savedSnap.data();

    return res.json({
      user: {
        id: sub,
        sub,
        ...saved,
      },
      created: !snap.exists,
    });
  } catch (err) {
    next(err);
  }
}

async function listMyReviews(req, res, next) {
  try {
    const userId = req.user?.sub; // set by requireAuth
    if (!userId) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Missing user identity" },
      });
    }

    const limit = Math.min(Number(req.query.limit ?? 50), 100);

    const snap = await db
      .collection("reviews")
      .where("userId", "==", userId)
      .orderBy("updatedAt", "desc")
      .limit(limit)
      .get();

    const reviews = snap.docs.map((d) => {
      const data = d.data();

      // IMPORTANT: don't leak doc id if it contains google sub
      // and you don't need it client-side.
      return {
        cityId: data.cityId,
        ratings: data.ratings,
        comment: data.comment ?? null,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    });

    res.json({ reviews });
  } catch (err) {
    next(err);
  }
}

module.exports = { getMe, listMyReviews };
