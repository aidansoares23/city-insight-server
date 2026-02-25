// src/services/cityService.js
const { db, admin } = require("../config/firebase");
const { computeAveragesFromStats } = require("../utils/cityStats");
const { getCityMetrics } = require("../utils/cityMetrics");
const { tsToIso, buildNextCursorFromDoc } = require("../lib/firestore");

function normalizeCityIdFromParam(param) {
  return String(param ?? "")
    .trim()
    .toLowerCase();
}

function toFiniteOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function cmpNullLastDesc(a, b) {
  const av = toFiniteOrNull(a);
  const bv = toFiniteOrNull(b);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return bv - av;
}

function cmpNullLastAsc(a, b) {
  const av = toFiniteOrNull(a);
  const bv = toFiniteOrNull(b);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return av - bv;
}

async function listCities({ limit = 50, q = "", sort = "name_asc" } = {}) {
  const safeLimit = Math.min(Number(limit) || 50, 100);
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
    .limit(safeLimit)
    .get();

  const baseCities = snap.docs.map((d) => {
    const data = d.data() || {};
    return {
      id: d.id, // slug
      slug: data.slug ?? d.id,
      name: data.name ?? null,
      state: data.state ?? null,
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

    // Back-compat: accept either medianRent or medianGrossRent
    const medianRent =
      metricsDoc?.medianRent ?? metricsDoc?.medianGrossRent ?? null;

    return {
      id: c.id,
      slug: c.slug,
      name: c.name,
      state: c.state,

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

  return {
    cities,
    meta: { limit: safeLimit, q: queryQ || null, sort: sortKey },
  };
}

async function getCityBySlug(slug) {
  const cityId = normalizeCityIdFromParam(slug);
  const snap = await db.collection("cities").doc(cityId).get();
  if (!snap.exists) return null;
  return { id: snap.id, data: snap.data() || {} };
}

async function getCityDetails(slug) {
  const cityId = normalizeCityIdFromParam(slug);

  // City
  const citySnap = await db.collection("cities").doc(cityId).get();
  if (!citySnap.exists) {
    const err = new Error("City not found");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }

  // stats
  const statsSnap = await db.collection("city_stats").doc(cityId).get();
  const statsDoc = statsSnap.exists
    ? statsSnap.data() || {}
    : {
        cityId,
        count: 0,
        sums: {},
        livability: { score: null, version: "uncomputed" },
      };

  const stats = computeAveragesFromStats(statsDoc);

  // objective metrics (your util returns normalized)
  const metrics = await getCityMetrics(cityId);

  const livability =
    statsDoc?.livability && typeof statsDoc.livability === "object"
      ? statsDoc.livability
      : { score: null, version: "uncomputed" };

  // reviews preview
  const pageSize = 10;
  const reviewsSnap = await db
    .collection("reviews")
    .where("cityId", "==", cityId)
    .orderBy("createdAt", "desc")
    .orderBy(admin.firestore.FieldPath.documentId(), "desc")
    .limit(pageSize)
    .get();

  const previewLen = 160;
  const reviews = reviewsSnap.docs.map((d) => {
    const data = d.data() || {};
    const comment = typeof data.comment === "string" ? data.comment : "";

    return {
      ratings: {
        overall: data?.ratings?.overall ?? null,
        safety: data?.ratings?.safety ?? null,
        cost: data?.ratings?.cost ?? null,
        traffic: data?.ratings?.traffic ?? null,
        cleanliness: data?.ratings?.cleanliness ?? null,
      },
      commentPreview: comment
        ? comment.slice(0, previewLen) +
          (comment.length > previewLen ? "…" : "")
        : null,
      createdAtIso: tsToIso(data.createdAt),
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
    createdAtIso: tsToIso(cityData.createdAt),
    updatedAtIso: tsToIso(cityData.updatedAt),
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
