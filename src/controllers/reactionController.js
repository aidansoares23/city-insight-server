const { db } = require("../config/firebase");
const reactionService = require("../services/reactionService");

const VALID_TYPES = ["helpful", "agree", "disagree"];

/**
 * PUT /cities/:slug/reviews/:reviewId/reactions/:type
 * Creates or replaces the authenticated user's reaction on a review.
 * - 400 if type is not one of helpful/agree/disagree
 * - 404 if the review doesn't exist or doesn't belong to this city
 * - 403 if the user tries to react to their own review
 */
async function upsertReaction(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();
    const reviewId = String(req.params.reviewId).trim();
    const type = String(req.params.type).trim().toLowerCase();
    const userId = req.user.sub;

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: `type must be one of: ${VALID_TYPES.join(", ")}`,
        },
      });
    }

    // Fetch the review to verify it exists, belongs to this city, and isn't the user's own
    const reviewSnap = await db.collection("reviews").doc(reviewId).get();
    if (!reviewSnap.exists) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Review not found" },
      });
    }

    const reviewData = reviewSnap.data();
    if (reviewData.cityId !== cityId) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Review not found for this city" },
      });
    }

    if (reviewData.userId === userId) {
      return res.status(403).json({
        error: {
          code: "CANNOT_REACT_TO_OWN_REVIEW",
          message: "You cannot react to your own review",
        },
      });
    }

    await reactionService.upsertReaction({ userId, reviewId, cityId, type });

    return res.json({ ok: true, reaction: { type, reviewId } });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /cities/:slug/reviews/:reviewId/reactions
 * Removes the authenticated user's reaction on a review.
 * Always returns 200 (idempotent).
 */
async function deleteReaction(req, res, next) {
  try {
    const reviewId = String(req.params.reviewId).trim();
    const userId = req.user.sub;

    await reactionService.deleteReaction({ userId, reviewId });

    return res.json({ ok: true, deleted: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { upsertReaction, deleteReaction };
