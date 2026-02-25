// src/controllers/meController.js
const meService = require("../services/meService");

async function getMe(req, res, next) {
  try {
    const result = await meService.upsertMeFromAuthClaims(req.user);
    return res.json({
      user: { id: result.sub, sub: result.sub, ...(result.user || {}) },
      created: result.created,
    });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({
        error: {
          code: err.code || "ERROR",
          message: err.message || "Request failed",
        },
      });
    }
    next(err);
  }
}

async function listMyReviews(req, res, next) {
  try {
    const userId = req.user?.sub;
    const limit = Math.min(Number(req.query.limit ?? 50), 100);
    const reviews = await meService.listMyReviews({ userId, limit });
    res.json({ reviews });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({
        error: {
          code: err.code || "ERROR",
          message: err.message || "Request failed",
        },
      });
    }
    next(err);
  }
}

module.exports = { getMe, listMyReviews };
