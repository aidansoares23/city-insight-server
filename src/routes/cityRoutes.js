// src/routes/cityRoutes.js
const express = require("express");
const router = express.Router();

const {
  listCities,
  getCityBySlug,
  getCityDetails,
} = require("../controllers/cityController");

const {
  listReviewsForCity,
  getMyReviewForCity,
  createOrUpdateReviewForCity,
  deleteMyReviewForCity,
  getReviewByIdForCity,
} = require("../controllers/reviewController");

const { requireAuth } = require("../middleware/requireAuth");

/**
 * -------------------------
 * Cities
 * -------------------------
 */
router.get("/", listCities);
router.get("/:slug", getCityBySlug);
router.get("/:slug/details", getCityDetails);

/**
 * -------------------------
 * City Reviews (nested)
 * -------------------------
 *
 * IMPORTANT:
 * Put "/me" routes BEFORE "/:reviewId" or Express will treat "me" as a reviewId.
 */
router.get("/:slug/reviews", listReviewsForCity);

// Auth “me” routes
router.get("/:slug/reviews/me", requireAuth, getMyReviewForCity);
router.post("/:slug/reviews", requireAuth, createOrUpdateReviewForCity);
router.delete("/:slug/reviews/me", requireAuth, deleteMyReviewForCity);

// Public single-review route (for clicking into a review)
router.get("/:slug/reviews/:reviewId", getReviewByIdForCity);

module.exports = router;
