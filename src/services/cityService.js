// src/services/cityService.js
const { db, admin } = require("../config/firebase");
const { computeAveragesFromStats } = require("../utils/cityStats");
const { getCityMetrics } = require("../utils/cityMetrics");
const { tsToIso, buildNextCursorFromDoc } = require("../lib/firestore");
const { toNumOrNull } = require("../lib/numbers");
const { AppError } = require("../lib/errors");

function normalizeCityIdFromParam(param) {
  return String(param ?? "")
    .trim()
    .toLowerCase();
}

function cmpNullLastDesc(a, b) {
  const av = toNumOrNull(a);
  const bv = toNumOrNull(b);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return bv - av;
}

function cmpNullLastAsc(a, b) {
  const av = toNumOrNull(a);
  const bv = toNumOrNull(b);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return av - bv;
}

async function listCities({ limit, q, sort } = {}) {
  const parsedLimit = Number.parseInt(String(limit ?? "50"), 10);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, 100))
    : 50;
  const queryQ = String(q || "")
    .trim()
    .toLowerCase();
  const sortKey = String(sort || "name_asc")
    .trim()
    .toLowerCase();

  // 1) Base city docs
  const snap = await db
    .collection("cities")
    .orderBy("name", "asc")
    .get();

  const baseCities = snap.docs.map((d) => {
    const data = d.data() || {};
    return {
      id: d.id, // slug
      slug: data.slug ?? d.id,
      name: data.name ?? null,
      state: data.state ?? null,
      lat: data.lat ?? null,
      lng: data.lng ?? null,
    };
  });

  // 2) Batch fetch stats + metrics
  const statsRefs = baseCities.map((c) =>
    db.collection("city_stats").doc(c.id),
  );
  const metricsRefs = baseCities.map((c) =>
    db.collection("city_metrics").doc(c.id),
  );

  const [statsSnaps, metricsSnaps] = await Promise.all([
    statsRefs.length ? db.getAll(...statsRefs) : Promise.resolve([]),
    metricsRefs.length ? db.getAll(...metricsRefs) : Promise.resolve([]),
  ]);

  // 3) Card projection
  let cities = baseCities.map((c, idx) => {
    const statsDoc = statsSnaps[idx]?.exists
      ? statsSnaps[idx].data() || {}
      : {};
    const metricsDoc = metricsSnaps[idx]?.exists
      ? metricsSnaps[idx].data() || {}
      : {};

    const reviewCount = Number(statsDoc?.count ?? 0);
    const livabilityScore = statsDoc?.livability?.score ?? null;

    const medianRent = metricsDoc?.medianRent ?? null;

    return {
      id: c.id,
      slug: c.slug,
      name: c.name,
      state: c.state,
      lat: c.lat,
      lng: c.lng,

      reviewCount,
      livabilityScore,
      safetyScore: metricsDoc?.safetyScore ?? null,
      medianRent,
      crimeIndexPer100k: metricsDoc?.crimeIndexPer100k ?? null,
    };
  });

  // 4) Optional search
  if (queryQ) {
    cities = cities.filter((c) => {
      const hay =
        `${c.name || ""} ${c.state || ""} ${c.slug || ""}`.toLowerCase();
      return hay.includes(queryQ);
    });
  }

  // 5) Optional sort
  switch (sortKey) {
    case "livability_desc":
      cities.sort((a, b) =>
        cmpNullLastDesc(a.livabilityScore, b.livabilityScore),
      );
      break;
    case "safety_desc":
      cities.sort((a, b) => cmpNullLastDesc(a.safetyScore, b.safetyScore));
      break;
    case "rent_asc":
      cities.sort((a, b) => cmpNullLastAsc(a.medianRent, b.medianRent));
      break;
    case "rent_desc":
      cities.sort((a, b) => cmpNullLastDesc(a.medianRent, b.medianRent));
      break;
    case "reviews_desc":
      cities.sort((a, b) => cmpNullLastDesc(a.reviewCount, b.reviewCount));
      break;
    case "name_asc":
    default:
      cities.sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || "")),
      );
      break;
  }

  cities = cities.slice(0, safeLimit);

  return {
    cities,
    meta: { limit: safeLimit, q: queryQ || null, sort: sortKey },
  };
}

async function getCityBySlug(slug) {
  const cityId = normalizeCityIdFromParam(slug);
  const snap = await db.collection("cities").doc(cityId).get();
  if (!snap.exists) {
    throw new AppError("City not found", { status: 404, code: "NOT_FOUND" });
  }
  return { id: snap.id, data: snap.data() || {} };
}

async function getCityDetails(slug) {
  const cityId = normalizeCityIdFromParam(slug);

  // City
  const citySnap = await db.collection("cities").doc(cityId).get();
  if (!citySnap.exists) {
    throw new AppError("City not found", { status: 404, code: "NOT_FOUND" });
  }

  // Fetch stats, metrics, and reviews preview in parallel — all independent of each other.
  const pageSize = 10;
  const [statsSnap, metrics, reviewsSnap] = await Promise.all([
    db.collection("city_stats").doc(cityId).get(),
    getCityMetrics(cityId),
    db
      .collection("reviews")
      .where("cityId", "==", cityId)
      .orderBy("createdAt", "desc")
      .orderBy(admin.firestore.FieldPath.documentId(), "desc")
      .limit(pageSize)
      .get(),
  ]);

  const statsDoc = statsSnap.exists
    ? statsSnap.data() || {}
    : {
        cityId,
        count: 0,
        sums: {},
        livability: { score: null, version: "uncomputed" },
      };

  const stats = computeAveragesFromStats(statsDoc);

  const livability =
    statsDoc?.livability && typeof statsDoc.livability === "object"
      ? statsDoc.livability
      : { score: null, version: "uncomputed" };

  const previewLen = 160;
  const reviews = reviewsSnap.docs.map((d) => {
    const data = d.data() || {};
    const comment = typeof data.comment === "string" ? data.comment : "";

    return {
      ratings: {
        overall: data?.ratings?.overall ?? null,
        safety: data?.ratings?.safety ?? null,
        affordability: data?.ratings?.affordability ?? null,
        walkability: data?.ratings?.walkability ?? null,
        cleanliness: data?.ratings?.cleanliness ?? null,
      },
      commentPreview: comment
        ? comment.slice(0, previewLen) +
          (comment.length > previewLen ? "…" : "")
        : null,
      createdAt: tsToIso(data.createdAt),
    };
  });

  const nextCursor = reviewsSnap.docs.length
    ? buildNextCursorFromDoc(reviewsSnap.docs[reviewsSnap.docs.length - 1])
    : null;

  const cityData = citySnap.data() || {};
  const city = {
    id: citySnap.id,
    slug: cityData.slug ?? citySnap.id,
    name: cityData.name ?? null,
    state: cityData.state ?? null,
    lat: cityData.lat ?? null,
    lng: cityData.lng ?? null,
    tagline: cityData.tagline ?? null,
    description: cityData.description ?? null,
    highlights: Array.isArray(cityData.highlights) ? cityData.highlights : [],
    createdAt: tsToIso(cityData.createdAt),
    updatedAt: tsToIso(cityData.updatedAt),
  };

  return {
    city,
    stats,
    metrics,
    livability,
    reviews,
    reviewsPage: { pageSize, nextCursor },
  };
}

module.exports = {
  listCities,
  getCityBySlug,
  getCityDetails,
};
