const meService = require("../services/meService");

/** Upserts the authenticated user from their JWT claims and returns `{ user, created }`. */
async function getMe(req, res, next) {
  try {
    const result = await meService.upsertMeFromAuthClaims(req.user);
    return res.json({
      user: { id: result.sub, sub: result.sub, ...(result.user || {}) },
      created: result.created,
    });
  } catch (err) {
    next(err);
  }
}

/** Returns the authenticated user's reviews; accepts `limit` query param (capped at 100). */
async function listMyReviews(req, res, next) {
  try {
    const userId = req.user.sub;
    const rawLimit = Number(req.query.limit ?? 50);
    const limit = Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, 100);
    const reviews = await meService.listMyReviews({ userId, limit });
    res.json({ reviews });
  } catch (err) {
    next(err);
  }
}

/** Permanently deletes the authenticated user's account and all their reviews. */
async function deleteAccount(req, res, next) {
  try {
    const userId = req.user.sub;
    await meService.deleteAccount({ userId });
    res.json({ ok: true, deleted: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getMe, listMyReviews, deleteAccount };
