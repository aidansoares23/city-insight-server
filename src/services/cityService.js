const { db, admin } = require("../config/firebase");
const { computeAveragesFromStats } = require("../utils/cityStats");
const { getCityMetrics } = require("../utils/cityMetrics");
const { tsToIso, buildNextCursorFromDoc } = require("../lib/firestore");
const { toNumOrNull } = require("../lib/numbers");
const { AppError } = require("../lib/errors");

/** Trims and lowercases a raw city ID / slug for consistent Firestore doc lookups. */
function normalizeId(rawId) {
  return String(rawId ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Descending comparator that sorts `null` values to the end.
 * Ensures cities with no data for a metric don't crowd the top of sorted lists.
 */
function cmpNullLastDesc(a, b) {
  const aNum = toNumOrNull(a);
  const bNum = toNumOrNull(b);
  if (aNum == null && bNum == null) return 0;
  if (aNum == null) return 1;
  if (bNum == null) return -1;
  return bNum - aNum;
}

/** Ascending comparator that sorts `null` values to the end. */
function cmpNullLastAsc(a, b) {
  const aNum = toNumOrNull(a);
  const bNum = toNumOrNull(b);
  if (aNum == null && bNum == null) return 0;
  if (aNum == null) return 1;
  if (bNum == null) return -1;
  return aNum - bNum;
}

// ---------------------------------------------------------------------------
// City list cache — avoids 3N Firestore reads on every Cities page load.
// Stores the merged rows (city + stats + metrics) before search/sort/limit.
// TTL of 3 minutes; sync scripts can call invalidateCityListCache() after writes.
// ---------------------------------------------------------------------------
let cityListCache = { rows: null, loadedAt: 0 };
let cityListInflight = null;
const CITY_LIST_CACHE_TTL_MS = 3 * 60 * 1000;

/** Clears the city list cache. Call after any write that changes city data. */
function invalidateCityListCache() {
  cityListCache = { rows: null, loadedAt: 0 };
}

/**
 * Fetches and merges all city rows (city + stats + metrics) from Firestore,
 * with a short in-memory cache to prevent repeated full-collection reads.
 */
async function fetchAllCityRows() {
  if (
    cityListCache.rows &&
    Date.now() - cityListCache.loadedAt < CITY_LIST_CACHE_TTL_MS
  ) {
    return cityListCache.rows;
  }
  if (cityListInflight) return cityListInflight;

  cityListInflight = (async () => {
    const snap = await db.collection("cities").orderBy("name", "asc").get();

    const baseCities = snap.docs.map((doc) => {
      const d = doc.data() || {};
      return {
        id: doc.id,
        slug: d.slug ?? doc.id,
        name: d.name ?? null,
        state: d.state ?? null,
        lat: d.lat ?? null,
        lng: d.lng ?? null,
      };
    });

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

    const rows = baseCities.map((city, idx) => {
      const statsDoc = statsSnaps[idx]?.exists
        ? statsSnaps[idx].data() || {}
        : {};
      const metricsDoc = metricsSnaps[idx]?.exists
        ? metricsSnaps[idx].data() || {}
        : {};

      const { averages } = computeAveragesFromStats(statsDoc);

      return {
        id: city.id,
        slug: city.slug,
        name: city.name,
        state: city.state,
        lat: city.lat,
        lng: city.lng,
        reviewCount: Number(statsDoc?.count ?? 0),
        livabilityScore: statsDoc?.livability?.score ?? null,
        safetyScore: metricsDoc?.safetyScore ?? null,
        medianRent: metricsDoc?.medianRent ?? null,
        aqiValue: metricsDoc?.aqiValue ?? null,
        population: toNumOrNull(metricsDoc?.population),
        walkabilityAvg: averages.walkability,
        cleanlinessAvg: averages.cleanliness,
        overallAvg: averages.overall,
      };
    });

    cityListCache = { rows, loadedAt: Date.now() };
    return rows;
  })().finally(() => {
    cityListInflight = null;
  });

  return cityListInflight;
}

// ---------------------------------------------------------------------------
// City details cache — city/stats/metrics docs are stable between review
// submissions. Cache for 5 minutes; invalidate after any review write.
// ---------------------------------------------------------------------------
const cityDetailsCache = new Map(); // cityId -> { data, loadedAt }
const CITY_DETAILS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Clears the city details cache for a specific city. Call after any review write. */
function invalidateCityDetailsCache(cityId) {
  if (cityId) cityDetailsCache.delete(normalizeId(cityId));
}

// ---------------------------------------------------------------------------
// City attractions cache — attractions only change during weekly sync,
// so a 10-minute TTL avoids re-reading the same data on every city visit.
// ---------------------------------------------------------------------------
const cityAttractionsCache = new Map(); // cityId -> { data, loadedAt }
const ATTRACTIONS_CACHE_TTL_MS = 10 * 60 * 1000;

/** Clears the attractions cache entry for a city. Call after a sync write. */
function invalidateCityAttractionsCache(cityId) {
  cityAttractionsCache.delete(normalizeId(cityId));
}

/**
 * Returns a filtered, sorted, and paginated list of cities with stats and metrics.
 * Uses an in-memory cache to avoid re-fetching all Firestore data on every request.
 * @param {object} [options]
 * @param {number|string} [options.limit=50] - max results, capped at 100
 * @param {string} [options.q] - search string matched against name, state, and slug
 * @param {string} [options.sort="name_asc"] - sort key: `name_asc`, `livability_desc`, `safety_desc`, `rent_asc`, `rent_desc`, `reviews_desc`
 * @returns {Promise<{ cities: object[], meta: object }>}
 */
async function listCities({ limit, q, sort } = {}) {
  const parsedLimit = Number.parseInt(String(limit ?? "50"), 10);
  const safeLimit = Number.isFinite(parsedLimit) ? Math.max(1, parsedLimit) : 50;
  const search = String(q || "")
    .trim()
    .toLowerCase();
  const sortKey = String(sort || "name_asc")
    .trim()
    .toLowerCase();

  // Pull from cache (or Firestore on cache miss) — search/sort/limit applied in memory
  let cities = await fetchAllCityRows();

  if (search) {
    cities = cities.filter((city) => {
      const searchTarget =
        `${city.name || ""} ${city.state || ""} ${city.slug || ""}`.toLowerCase();
      return searchTarget.includes(search);
    });
  }

  // Sort on a copy so we don't mutate the cached array
  cities = [...cities];

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

/**
 * Fetches a single city document by slug; throws a 404 `AppError` if not found.
 * @param {string} slug
 * @returns {Promise<{ id: string, data: object }>}
 */
async function getCityBySlug(slug) {
  const cityId = normalizeId(slug);
  const snap = await db.collection("cities").doc(cityId).get();
  if (!snap.exists) {
    throw new AppError("City not found", { status: 404, code: "NOT_FOUND" });
  }
  return { id: snap.id, data: snap.data() || {} };
}

/**
 * Returns full city detail: city fields, computed rating averages, external metrics,
 * livability score, and the most recent 10 reviews with a pagination cursor.
 * Throws a 404 `AppError` if the city does not exist.
 * @param {string} slug
 * @returns {Promise<{ city: object, stats: object, metrics: object, livability: object, reviews: object[], reviewsPage: object }>}
 */
async function getCityDetails(slug) {
  const cityId = normalizeId(slug);

  const cached = cityDetailsCache.get(cityId);
  if (cached && Date.now() - cached.loadedAt < CITY_DETAILS_CACHE_TTL_MS) {
    return cached.data;
  }

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

  const result = {
    city,
    stats,
    metrics,
    livability,
    reviews,
    reviewsPage: { pageSize, nextCursor },
  };

  cityDetailsCache.set(cityId, { data: result, loadedAt: Date.now() });
  return result;
}

const EMPTY_CATEGORIES = { attractions: [], restaurants: [], outdoors: [], nightlife: [] };

/**
 * Returns cached "things to do" attractions for a city from `city_attractions`.
 * Results are cached for 10 minutes since attractions only change during weekly sync.
 * Returns empty category arrays gracefully if no sync has been run yet.
 * Throws a 404 `AppError` if the city itself does not exist.
 * @param {string} slug
 * @returns {Promise<{ cityId: string, categories: object, syncedAtIso: string|null, source: string|null }>}
 */
async function getCityAttractions(slug) {
  const cityId = normalizeId(slug);

  const cached = cityAttractionsCache.get(cityId);
  if (cached && Date.now() - cached.loadedAt < ATTRACTIONS_CACHE_TTL_MS) {
    return cached.data;
  }

  const [citySnap, attractionsSnap] = await Promise.all([
    db.collection("cities").doc(cityId).get(),
    db.collection("city_attractions").doc(cityId).get(),
  ]);

  if (!citySnap.exists) {
    throw new AppError("City not found", { status: 404, code: "NOT_FOUND" });
  }

  const data = attractionsSnap.exists ? attractionsSnap.data() || {} : {};
  const result = {
    cityId,
    categories: data.categories ?? EMPTY_CATEGORIES,
    syncedAtIso: data.syncedAtIso ?? null,
    source: data.source ?? null,
  };

  cityAttractionsCache.set(cityId, { data: result, loadedAt: Date.now() });
  return result;
}

// ---------------------------------------------------------------------------
// City recommendation engine
// ---------------------------------------------------------------------------

const RECOMMENDATION_KEYS = ["safety", "affordability", "walkability", "cleanliness", "environment"];

/**
 * Returns the top 5 cities matching a user's preference weights.
 * @param {object} options
 * @param {object} [options.rawWeights={}] - Raw user-supplied weights (0–10 per key)
 * @param {string|null} [options.stateFilter] - Two-letter state abbreviation to restrict results
 * @param {string|null} [options.sizeFilter] - "small" | "medium" | "large" | "any" | null
 * @returns {Promise<{ cities: object[] }>}
 */
async function recommendCities({ rawWeights = {}, stateFilter = null, sizeFilter = null } = {}) {
  // Phase 1: Parse and normalize weights
  const parsed = {};
  for (const k of RECOMMENDATION_KEYS) {
    const v = parseFloat(rawWeights[k]);
    parsed[k] = Number.isFinite(v) ? Math.min(10, Math.max(0, v)) : 5;
  }
  const totalWeight = RECOMMENDATION_KEYS.reduce((s, k) => s + parsed[k], 0);
  const weights = {};
  for (const k of RECOMMENDATION_KEYS) {
    weights[k] = totalWeight > 0 ? parsed[k] / totalWeight : 1 / RECOMMENDATION_KEYS.length;
  }

  // Phase 2: Fetch city data and apply filters
  const allRows = await fetchAllCityRows();
  let rows = stateFilter
    ? allRows.filter((c) => c.state?.toUpperCase() === stateFilter)
    : allRows;

  if (sizeFilter && sizeFilter !== "any") {
    rows = rows.filter((c) => {
      const pop = c.population;
      if (pop == null) return true;
      if (sizeFilter === "small")  return pop < 200_000;
      if (sizeFilter === "medium") return pop >= 200_000 && pop < 750_000;
      if (sizeFilter === "large")  return pop >= 750_000;
      return true;
    });
  }

  if (rows.length === 0) return { cities: [] };

  // Phase 3: Score and rank — all signal data already available in row objects
  const { medianRentToAffordability10, normalizeSafetyTo10 } = require("../lib/numbers");

  const scored = rows.map((row) => {
    const safetyVal   = normalizeSafetyTo10(row.safetyScore);
    const safetyNorm  = safetyVal != null ? safetyVal / 10 : null;
    const affNorm     = medianRentToAffordability10(row.medianRent);
    const affNormFrac = affNorm != null ? affNorm / 10 : null;
    // walkability and cleanliness use pre-computed averages from city_stats
    const walkNorm  = row.reviewCount > 0 && row.walkabilityAvg  != null ? row.walkabilityAvg  / 10 : null;
    const cleanNorm = row.reviewCount > 0 && row.cleanlinessAvg != null ? row.cleanlinessAvg / 10 : null;
    // environment: AQI (lower = better); falls back to cleanliness
    const aqiVal  = row.aqiValue;
    const envNorm = aqiVal != null ? Math.max(0, 1 - aqiVal / 150) : cleanNorm;

    const signals = [
      { key: "safety",        norm: safetyNorm  },
      { key: "affordability", norm: affNormFrac },
      { key: "walkability",   norm: walkNorm    },
      { key: "cleanliness",   norm: cleanNorm   },
      { key: "environment",   norm: envNorm     },
    ];

    // Renormalise among available signals only
    const available = signals.filter((s) => s.norm != null);
    if (available.length === 0) return null;
    const usedWeight = available.reduce((s, sig) => s + weights[sig.key], 0);
    const matchScore = usedWeight > 0
      ? available.reduce((s, sig) => s + sig.norm * (weights[sig.key] / usedWeight), 0)
      : 0;

    return {
      slug: row.slug ?? row.id,
      name: row.name,
      state: row.state,
      medianRent: row.medianRent ?? null,
      population: row.population ?? null,
      reviewCount: row.reviewCount ?? 0,
      matchScore,
      scores: {
        safety:        safetyVal  != null ? Math.round(safetyVal  * 10) / 10 : null,
        affordability: affNorm    != null ? Math.round(affNorm    * 10) / 10 : null,
        walkability:   walkNorm   != null ? Math.round(walkNorm   * 100) / 10 : null,
        cleanliness:   cleanNorm  != null ? Math.round(cleanNorm  * 100) / 10 : null,
        livability:    row.livabilityScore ?? null,
      },
    };
  }).filter(Boolean);

  scored.sort((a, b) => b.matchScore - a.matchScore);

  const top5 = scored.slice(0, 5).map((c, idx) => ({
    rank: idx + 1,
    ...c,
    matchPct: Math.round(c.matchScore * 100),
  }));

  return { cities: top5 };
}

module.exports = {
  listCities,
  getCityBySlug,
  getCityDetails,
  getCityAttractions,
  fetchAllCityRows,
  recommendCities,
  invalidateCityListCache,
  invalidateCityDetailsCache,
  invalidateCityAttractionsCache,
};
