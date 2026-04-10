const { db } = require("../config/firebase");
const { computeAveragesFromStats } = require("../utils/cityStats");
const { tsToIso } = require("../lib/firestore");
const { fetchAllCityRows } = require("./cityService");

// ---------------------------------------------------------------------------
// Short-lived city lookup cache — avoids re-fetching the same city docs when
// multiple tools (getCity, aggregateReviews, compareCities) reference the same
// city within a single agentic loop invocation.
// TTL matches the city details cache in cityService (5 minutes).
// ---------------------------------------------------------------------------
const getCityCache = new Map(); // normalizedName -> { result, loadedAt }
const GET_CITY_CACHE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// City name matching helper
// ---------------------------------------------------------------------------

/**
 * Normalizes a city name input for slug-style matching.
 * "Portland, OR" -> "portland-or"
 * "St. Louis" -> "st-louis"
 */
function nameToSlugGuess(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s,-]/g, "")
    .replace(/,\s*/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/**
 * Searches for cities by name (case-insensitive substring match against name and slug).
 * Returns up to 3 matches with their stats and metrics.
 * @param {string} name - City name or "City, ST" format
 * @returns {Promise<{ found: boolean, cities: object[] }>}
 */
async function getCity(name) {
  const raw = String(name || "").trim();
  const cacheKey = raw.toLowerCase();
  const cached = getCityCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < GET_CITY_CACHE_TTL_MS) {
    return cached.result;
  }

  const searchLower = cacheKey;
  const slugGuess = nameToSlugGuess(raw);

  const allRows = await fetchAllCityRows();

  // Score matches: exact slug > exact name > name starts-with > name/combined contains > slug contains
  const scored = allRows
    .map((row) => {
      const docSlug = row.id;
      const docName = String(row.name || "").toLowerCase();
      const docState = String(row.state || "").toLowerCase();
      const combined = `${docName}, ${docState}`;

      if (docSlug === slugGuess) return { row, score: 4 };
      if (docName === searchLower) return { row, score: 3 };
      if (docName.startsWith(searchLower)) return { row, score: 2 };
      if (docName.includes(searchLower) || combined.includes(searchLower)) return { row, score: 1 };
      if (docSlug.includes(slugGuess)) return { row, score: 1 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (scored.length === 0) {
    const notFound = { found: false, cities: [] };
    getCityCache.set(cacheKey, { result: notFound, loadedAt: Date.now() });
    return notFound;
  }

  const cityIds = scored.map((s) => s.row.id);

  // Fetch full city docs (for tagline/description/highlights) + stats + metrics for matched cities only.
  const [citySnaps, statsSnaps, metricsSnaps] = await Promise.all([
    db.getAll(...cityIds.map((id) => db.collection("cities").doc(id))),
    db.getAll(...cityIds.map((id) => db.collection("city_stats").doc(id))),
    db.getAll(...cityIds.map((id) => db.collection("city_metrics").doc(id))),
  ]);

  const cities = scored.map((s, idx) => {
    const cityData = citySnaps[idx]?.exists ? citySnaps[idx].data() || {} : {};
    const statsDoc = statsSnaps[idx]?.exists ? statsSnaps[idx].data() || {} : {};
    const metricsDoc = metricsSnaps[idx]?.exists ? metricsSnaps[idx].data() || {} : {};
    const { count, averages } = computeAveragesFromStats(statsDoc);

    return {
      slug: s.row.id,
      name: s.row.name ?? null,
      state: s.row.state ?? null,
      tagline: cityData.tagline ?? null,
      description: cityData.description ?? null,
      highlights: Array.isArray(cityData.highlights) ? cityData.highlights : [],
      stats: {
        reviewCount: count,
        livabilityScore: statsDoc?.livability?.score ?? null,
        averages,
      },
      metrics: {
        medianRent: metricsDoc?.medianRent ?? null,
        population: metricsDoc?.population ?? null,
        safetyScore: metricsDoc?.safetyScore ?? null,
        aqiValue: metricsDoc?.aqiValue ?? null,
      },
    };
  });

  const result = { found: true, cities };
  getCityCache.set(cacheKey, { result, loadedAt: Date.now() });
  return result;
}

/**
 * Returns aggregated review statistics for a city, including
 * rating averages, review count, and up to 8 recent review excerpts.
 * @param {string} cityName
 * @returns {Promise<object>}
 */
async function aggregateReviews(cityName) {
  const result = await getCity(cityName);
  if (!result.found || result.cities.length === 0) {
    return { found: false, message: `No city found matching "${cityName}".` };
  }

  const city = result.cities[0];
  const cityId = city.slug;

  // city.stats already has count/averages/livabilityScore from getCity — no need to re-fetch city_stats
  const reviewsSnap = await db
    .collection("reviews")
    .where("cityId", "==", cityId)
    .orderBy("createdAt", "desc")
    .limit(8)
    .get();

  const recentReviews = reviewsSnap.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      ratings: {
        overall: data?.ratings?.overall ?? null,
        safety: data?.ratings?.safety ?? null,
        affordability: data?.ratings?.affordability ?? null,
        walkability: data?.ratings?.walkability ?? null,
        cleanliness: data?.ratings?.cleanliness ?? null,
      },
      comment: data.comment ? String(data.comment).slice(0, 600) : null,
      createdAt: tsToIso(data.createdAt),
    };
  });

  return {
    found: true,
    city: { name: city.name, state: city.state, slug: cityId },
    reviewCount: city.stats.reviewCount,
    averages: city.stats.averages,
    livabilityScore: city.stats.livabilityScore,
    recentReviews,
  };
}

/**
 * Fetches full data for 2–4 cities and returns them side by side for comparison.
 * @param {string[]} cityNames - Array of 2–4 city name strings
 * @returns {Promise<{ cities: object[] }>}
 */
async function compareCities(cityNames) {
  const names = Array.isArray(cityNames) ? cityNames.slice(0, 4) : [];
  const results = await Promise.all(names.map((n) => getCity(n)));
  return {
    cities: results.map((r, i) =>
      r.found ? r.cities[0] : { found: false, query: names[i] }
    ),
  };
}

/**
 * Returns the top N cities ranked by a specific metric.
 *
 * Uses fetchAllCityRows() which is shared with the city list cache, so most
 * ranking queries (livabilityScore, safetyScore, affordability, reviewCount)
 * require no secondary Firestore fetch — the data is already in the cached rows.
 * Only per-category rating averages (walkabilityAvg, cleanlinessAvg, overallAvg)
 * require an additional city_stats batch read.
 *
 * Supported metrics:
 *   livabilityScore  — city_stats.livability.score   (desc, 0–100)
 *   safetyScore      — city_metrics.safetyScore      (desc, 0–10)
 *   affordability    — city_metrics.medianRent        (asc, lower rent = more affordable)
 *   reviewCount      — city_stats.count               (desc)
 *   walkabilityAvg / cleanlinessAvg / overallAvg      (desc, 1–10)
 *
 * @param {string} metric
 * @param {number} [limit=5]  max 10
 * @param {string|null} [state]  optional two-letter state filter
 * @returns {Promise<{ metric: string, cities: object[] } | { error: string }>}
 */
async function rankCities(metric, limit = 5, state = null, order = "desc") {
  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 5), 10);
  const stateFilter = state ? String(state).trim().toUpperCase() : null;
  const ascending = order === "asc";

  const VALID = ["livabilityScore", "safetyScore", "affordability", "reviewCount", "walkabilityAvg", "cleanlinessAvg", "overallAvg"];
  if (!VALID.includes(metric)) {
    return { error: `Unknown metric "${metric}". Valid options: ${VALID.join(", ")}.` };
  }

  const AVG_METRICS = ["walkabilityAvg", "cleanlinessAvg", "overallAvg"];

  const allRows = await fetchAllCityRows();

  let cities = allRows.map((row) => {
    let sortValue = null;
    let extra = {};

    if (metric === "livabilityScore") {
      sortValue = row.livabilityScore ?? null;
      extra = { livabilityScore: sortValue };
    } else if (metric === "safetyScore") {
      sortValue = row.safetyScore ?? null;
      extra = { safetyScore: sortValue, medianRent: row.medianRent ?? null };
    } else if (metric === "affordability") {
      const rent = row.medianRent ?? null;
      sortValue = rent != null && rent > 0 ? rent : null;
      extra = { medianRent: sortValue, safetyScore: row.safetyScore ?? null };
    } else if (metric === "reviewCount") {
      sortValue = row.reviewCount ?? null;
      extra = { reviewCount: sortValue };
    } else if (AVG_METRICS.includes(metric)) {
      sortValue = row.reviewCount > 0 ? (row[metric] ?? null) : null;
      extra = { [metric]: sortValue, reviewCount: row.reviewCount };
    }

    return { slug: row.id, name: row.name ?? null, state: row.state ?? null, sortValue, ...extra };
  });

  if (stateFilter) {
    cities = cities.filter((c) => c.state?.toUpperCase() === stateFilter);
  }

  // Null values sort to the bottom; affordability sorts ascending (cheapest first).
  const cmp =
    metric === "affordability" || ascending
      ? (a, b) => {
          if (a.sortValue == null && b.sortValue == null) return 0;
          if (a.sortValue == null) return 1;
          if (b.sortValue == null) return -1;
          return a.sortValue - b.sortValue;
        }
      : (a, b) => {
          if (a.sortValue == null && b.sortValue == null) return 0;
          if (a.sortValue == null) return 1;
          if (b.sortValue == null) return -1;
          return b.sortValue - a.sortValue;
        };

  cities.sort(cmp);

  return {
    metric,
    cities: cities.slice(0, safeLimit).map((c, idx) => {
      const { sortValue: _, ...rest } = c;
      return { rank: idx + 1, ...rest };
    }),
  };
}

/**
 * Filters cities by multiple optional threshold criteria and returns matches
 * sorted by livability score descending.
 *
 * Uses fetchAllCityRows() which carries livabilityScore, safetyScore, and medianRent,
 * so those filters require no secondary Firestore fetch. Only walkabilityAvg and
 * cleanlinessAvg filters require an additional city_stats batch read.
 *
 * @param {object} filters
 * @param {number} [filters.minSafetyScore]      - Minimum safetyScore (0–10)
 * @param {number} [filters.maxMedianRent]        - Maximum medianRent in dollars
 * @param {number} [filters.minLivabilityScore]   - Minimum livability score (0–100)
 * @param {number} [filters.minWalkabilityAvg]    - Minimum resident-rated walkability (1–10)
 * @param {number} [filters.minCleanlinessAvg]    - Minimum resident-rated cleanliness (1–10)
 * @param {string} [filters.state]                - Two-letter state abbreviation
 * @param {number} [filters.limit=10]             - Max results (capped at 10)
 * @returns {Promise<{ cities: object[] }>}
 */
async function filterCities({ minSafetyScore, maxMedianRent, minLivabilityScore, minWalkabilityAvg, minCleanlinessAvg, maxAqiValue, state, limit = 10 } = {}) {
  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 10), 10);
  const stateFilter = state ? String(state).trim().toUpperCase() : null;

  const allRows = await fetchAllCityRows();

  let cities = allRows.map((row) => {
    return {
      slug: row.id,
      name: row.name ?? null,
      state: row.state ?? null,
      livabilityScore: row.livabilityScore ?? null,
      safetyScore: row.safetyScore ?? null,
      medianRent: row.medianRent ?? null,
      aqiValue: row.aqiValue ?? null,
      walkabilityAvg: row.reviewCount > 0 ? (row.walkabilityAvg ?? null) : null,
      cleanlinessAvg: row.reviewCount > 0 ? (row.cleanlinessAvg ?? null) : null,
    };
  });

  if (stateFilter) {
    cities = cities.filter((c) => c.state?.toUpperCase() === stateFilter);
  }
  if (minSafetyScore != null) {
    cities = cities.filter((c) => c.safetyScore != null && c.safetyScore >= minSafetyScore);
  }
  if (maxMedianRent != null) {
    cities = cities.filter((c) => c.medianRent != null && c.medianRent <= maxMedianRent);
  }
  if (minLivabilityScore != null) {
    cities = cities.filter((c) => c.livabilityScore != null && c.livabilityScore >= minLivabilityScore);
  }
  if (minWalkabilityAvg != null) {
    cities = cities.filter((c) => c.walkabilityAvg != null && c.walkabilityAvg >= minWalkabilityAvg);
  }
  if (minCleanlinessAvg != null) {
    cities = cities.filter((c) => c.cleanlinessAvg != null && c.cleanlinessAvg >= minCleanlinessAvg);
  }
  if (maxAqiValue != null) {
    cities = cities.filter((c) => c.aqiValue != null && c.aqiValue <= maxAqiValue);
  }

  // Sort by livability descending; nulls go to the bottom.
  cities.sort((a, b) => {
    if (a.livabilityScore == null && b.livabilityScore == null) return 0;
    if (a.livabilityScore == null) return 1;
    if (b.livabilityScore == null) return -1;
    return b.livabilityScore - a.livabilityScore;
  });

  return {
    cities: cities.slice(0, safeLimit).map((c, idx) => ({ rank: idx + 1, ...c })),
  };
}

module.exports = { getCity, aggregateReviews, compareCities, rankCities, filterCities };
