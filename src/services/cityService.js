const { db, admin } = require("../config/firebase");
const { computeAveragesFromStats } = require("../utils/cityStats");
const { getCityMetrics } = require("../utils/cityMetrics");
const { tsToIso, buildNextCursorFromDoc } = require("../lib/firestore");
const { toNumOrNull } = require("../lib/numbers");
const { AppError } = require("../lib/errors");

function normalizeId(rawId) {
  return String(rawId ?? "")
    .trim()
    .toLowerCase();
}

// Cities with no data for a metric (null) sort to the end regardless of direction,
// so incomplete cities don't crowd the top of sorted lists.
function cmpNullLastDesc(a, b) {
  const aNum = toNumOrNull(a);
  const bNum = toNumOrNull(b);
  if (aNum == null && bNum == null) return 0;
  if (aNum == null) return 1;
  if (bNum == null) return -1;
  return bNum - aNum;
}

function cmpNullLastAsc(a, b) {
  const aNum = toNumOrNull(a);
  const bNum = toNumOrNull(b);
  if (aNum == null && bNum == null) return 0;
  if (aNum == null) return 1;
  if (bNum == null) return -1;
  return aNum - bNum;
}

async function listCities({ limit, q, sort } = {}) {
  const parsedLimit = Number.parseInt(String(limit ?? "50"), 10);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, 100))
    : 50;
  const search = String(q || "")
    .trim()
    .toLowerCase();
  const sortKey = String(sort || "name_asc")
    .trim()
    .toLowerCase();

  const snap = await db
    .collection("cities")
    .orderBy("name", "asc")
    .get();

  const baseCities = snap.docs.map((doc) => {
    const cityData = doc.data() || {};
    return {
      id: doc.id, // slug
      slug: cityData.slug ?? doc.id,
      name: cityData.name ?? null,
      state: cityData.state ?? null,
      lat: cityData.lat ?? null,
      lng: cityData.lng ?? null,
    };
  });

  // Bulk-fetch stats and metrics in two parallel batched reads instead of N×2
  // individual reads. db.getAll() preserves input order, so snaps[i] corresponds
  // to baseCities[i] and no extra lookup is needed when zipping the results.
  const statsRefs = baseCities.map((city) =>
    db.collection("city_stats").doc(city.id),
  );
  const metricsRefs = baseCities.map((city) =>
    db.collection("city_metrics").doc(city.id),
  );

  const [statsSnaps, metricsSnaps] = await Promise.all([
    statsRefs.length ? db.getAll(...statsRefs) : Promise.resolve([]),
    metricsRefs.length ? db.getAll(...metricsRefs) : Promise.resolve([]),
  ]);

  let cities = baseCities.map((city, idx) => {
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
      id: city.id,
      slug: city.slug,
      name: city.name,
      state: city.state,
      lat: city.lat,
      lng: city.lng,

      reviewCount,
      livabilityScore,
      safetyScore: metricsDoc?.safetyScore ?? null,
      medianRent,
      crimeIndexPer100k: metricsDoc?.crimeIndexPer100k ?? null,
    };
  });

  if (search) {
    cities = cities.filter((city) => {
      const searchTarget =
        `${city.name || ""} ${city.state || ""} ${city.slug || ""}`.toLowerCase();
      return searchTarget.includes(search);
    });
  }

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
    meta: { limit: safeLimit, q: search || null, sort: sortKey },
  };
}

async function getCityBySlug(slug) {
  const cityId = normalizeId(slug);
  const snap = await db.collection("cities").doc(cityId).get();
  if (!snap.exists) {
    throw new AppError("City not found", { status: 404, code: "NOT_FOUND" });
  }
  return { id: snap.id, data: snap.data() || {} };
}

async function getCityDetails(slug) {
  const cityId = normalizeId(slug);

  const citySnap = await db.collection("cities").doc(cityId).get();
  if (!citySnap.exists) {
    throw new AppError("City not found", { status: 404, code: "NOT_FOUND" });
  }

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
  const reviews = reviewsSnap.docs.map((doc) => {
    const data = doc.data() || {};
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
