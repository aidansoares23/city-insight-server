// src/controllers/reviewController.js
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

function toPublicReview(docId, data) {
  return withIsoTimestamps({
    id: docId,
    cityId: data.cityId,
    ratings: data.ratings,
    comment: data.comment ?? null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  });
}

function toMyReview(docId, data) {
  return withIsoTimestamps({
    id: docId,
    cityId: data.cityId,
    userId: data.userId, // keep for now
    ratings: data.ratings,
    comment: data.comment ?? null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  });
}

async function createOrUpdateReviewForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();

    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Missing or invalid auth" },
      });
    }

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

    const incomingRatings = normalizeIncomingRatings(req.body.ratings);
    const incomingComment = normalizeIncomingComment(req.body.comment);

    const result = await reviewService.upsertMyReviewForCity({
      cityId,
      userId,
      incomingRatings,
      incomingComment,
    });

    return res.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
      review: result.review ? toMyReview(result.reviewId, result.review) : null,
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

    const reviews = docs.map((d) => toPublicReview(d.id, d.data()));
    const nextCursor = docs.length
      ? buildNextCursorFromDoc(docs[docs.length - 1])
      : null;

    res.json({ reviews, pageSize, nextCursor });
  } catch (err) {
    next(err);
  }
}

async function getReviewByIdForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();
    const reviewId = String(req.params.reviewId).trim();

    const found = await reviewService.getReviewByIdForCity({
      cityId,
      reviewId,
    });
    if (!found) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "Review not found for this city" },
      });
    }

    return res.json({ review: toPublicReview(found.id, found.data) });
  } catch (err) {
    next(err);
  }
}

async function getMyReviewForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();

    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Missing or invalid auth" },
      });
    }

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

async function deleteMyReviewForCity(req, res, next) {
  try {
    const cityId = String(req.params.slug).trim().toLowerCase();

    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Missing or invalid auth" },
      });
    }

    await reviewService.deleteMyReviewForCity({ cityId, userId });
    return res.json({ ok: true, deleted: true });
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

module.exports = {
  createOrUpdateReviewForCity,
  listReviewsForCity,
  getReviewByIdForCity,
  getMyReviewForCity,
  deleteMyReviewForCity,
};
