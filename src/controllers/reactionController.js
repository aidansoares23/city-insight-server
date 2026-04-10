const reactionService = require("../services/reactionService");

const VALID_TYPES = ["helpful", "agree", "disagree"];

/**
 * PUT /cities/:slug/reviews/:reviewId/reactions/:type
 * Creates or replaces the authenticated user's reaction on a review.
 * - 400 if type is not one of helpful/agree/disagree
 * - 404 if the review doesn't exist or doesn't belong to this city (thrown by service)
 * - 403 if the user tries to react to their own review (thrown by service)
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
