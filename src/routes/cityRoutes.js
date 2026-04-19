const express = require("express");
const router = express.Router();

const {
  listCities,
  getCityBySlug,
  getCityDetails,
  getCityAttractions,
  getCitySummary,
  recommendCities,
} = require("../controllers/cityController");

const {
  listReviewsForCity,
  getMyReviewForCity,
  createOrUpdateReviewForCity,
  deleteMyReviewForCity,
  getReviewByIdForCity,
} = require("../controllers/reviewController");

const { requireAuth } = require("../middleware/requireAuth");
const { optionalAuth } = require("../middleware/optionalAuth");
const { upsertReaction, deleteReaction } = require("../controllers/reactionController");

/**
 * -------------------------
 * Cities
 * -------------------------
 */
router.get("/", listCities);
router.post("/recommend", recommendCities);
router.get("/:slug", getCityBySlug);
router.get("/:slug/details", getCityDetails);
router.get("/:slug/attractions", getCityAttractions);
router.get("/:slug/summary", getCitySummary);

/**
 * -------------------------
 * City Reviews (nested)
 * -------------------------
 *
 * IMPORTANT:
 * Put "/me" routes BEFORE "/:reviewId" or Express will treat "me" as a reviewId.
 */
router.get("/:slug/reviews", optionalAuth, listReviewsForCity);

// Auth “me” routes
router.get("/:slug/reviews/me", requireAuth, getMyReviewForCity);
router.post("/:slug/reviews", requireAuth, createOrUpdateReviewForCity);
router.delete("/:slug/reviews/me", requireAuth, deleteMyReviewForCity);

// Reaction routes — must come before /:reviewId to avoid Express treating "reactions" as a reviewId
router.put("/:slug/reviews/:reviewId/reactions/:type", requireAuth, upsertReaction);
router.delete("/:slug/reviews/:reviewId/reactions", requireAuth, deleteReaction);

// Public single-review route (for clicking into a review)
router.get("/:slug/reviews/:reviewId", getReviewByIdForCity);

module.exports = router;
