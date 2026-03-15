const {
  withIsoTimestamps,
  buildNextCursorFromDoc,
  parseCursorFromQuery,
} = require("../lib/firestore");
const {
  validateReviewBody,
  normalizeIncomingRatings,
  normalizeIncomingComment,
} = require("../lib/reviews");

const reviewService = require("../services/reviewService");

/** Shapes a Firestore review document into the public API response format with ISO timestamps. */
function toReview(docId, data) {
  return withIsoTimestamps({
    id: docId,
    cityId: data.cityId,
    ratings: data.ratings,
    comment: data.comment ?? null,
    isEdited: data.isEdited ?? false,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  });
}

/** Extends `toReview` with the `userId` field for authenticated user responses. */
function toMyReview(docId, data) {
  return { ...toReview(docId, data), userId: data.userId };
}

/** Validates and upserts the authenticated user's review for a city; returns 201 on create, 200 on update. */
async function createOrUpdateReviewForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();
    const userId = req.user.sub;

    const { ok, errors } = validateReviewBody(req.body);
    if (!ok) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid review payload",
          details: { errors },
        },
      });
    }

    const ratings = normalizeIncomingRatings(req.body.ratings);
    const comment = normalizeIncomingComment(req.body.comment);

    const result = await reviewService.upsertMyReviewForCity({
      cityId,
      userId,
      ratings,
      comment,
    });

    return res.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
      review: result.review ? toMyReview(result.reviewId, result.review) : null,
    });
  } catch (err) {
    next(err);
  }
}

/** Returns a paginated list of reviews for a city; accepts `pageSize` (1–50) and cursor query params. */
async function listReviewsForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();

    const rawPageSize = parseInt(req.query.pageSize || "10", 10);
    const pageSize = Math.max(
      1,
      Math.min(Number.isFinite(rawPageSize) ? rawPageSize : 10, 50),
    );

    const cursor = parseCursorFromQuery(req.query);

    const docs = await reviewService.listReviewsForCity({
      cityId,
      pageSize,
      cursor,
    });

    const reviews = docs.map((doc) => toReview(doc.id, doc.data()));
    const nextCursor = docs.length
      ? buildNextCursorFromDoc(docs[docs.length - 1])
      : null;

    res.json({ reviews, pageSize, nextCursor });
  } catch (err) {
    next(err);
  }
}

/** Fetches a single review by `reviewId` scoped to a city; 404s if not found or if the review belongs to a different city. */
async function getReviewByIdForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();
    const reviewId = String(req.params.reviewId).trim();

    const reviewDoc = await reviewService.getReviewByIdForCity({
      cityId,
      reviewId,
    });
    if (!reviewDoc) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Review not found for this city" },
      });
    }

    return res.json({ review: toReview(reviewDoc.id, reviewDoc.data) });
  } catch (err) {
    next(err);
  }
}

/** Returns the authenticated user's review for a city, or `{ review: null }` if none exists. */
async function getMyReviewForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();
    const userId = req.user.sub;

    const { reviewId, review } = await reviewService.getMyReviewForCity({
      cityId,
      userId,
    });
    if (!review) return res.json({ review: null });

    return res.json({ review: toMyReview(reviewId, review) });
  } catch (err) {
    next(err);
  }
}

/** Deletes the authenticated user's review for a city and returns `{ ok: true, deleted: true }`. */
async function deleteMyReviewForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();
    const userId = req.user.sub;

    await reviewService.deleteMyReviewForCity({ cityId, userId });
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createOrUpdateReviewForCity,
  listReviewsForCity,
  getReviewByIdForCity,
  getMyReviewForCity,
  deleteMyReviewForCity,
};
