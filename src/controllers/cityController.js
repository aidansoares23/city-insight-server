const { withIsoTimestamps } = require("../lib/firestore");
const cityService = require("../services/cityService");
const { getOrGenerateSummary } = require("../services/aiSummaryService");

/** Returns a filtered, sorted list of cities; accepts `limit`, `q` (search), and `sort` query params. */
async function listCities(req, res, next) {
  try {
    const result = await cityService.listCities({
      limit: req.query.limit,
      q: req.query.q,
      sort: req.query.sort,
    });
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

/** Returns a single city document by slug with ISO timestamps; 404s if not found. */
async function getCityBySlug(req, res, next) {
  try {
    const cityDoc = await cityService.getCityBySlug(req.params.slug);
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    return res.json({
      city: withIsoTimestamps({ id: cityDoc.id, ...cityDoc.data }),
    });
  } catch (err) {
    next(err);
  }
}

/** Returns full city detail: stats, metrics, livability score, and recent reviews. */
async function getCityDetails(req, res, next) {
  try {
    const result = await cityService.getCityDetails(req.params.slug);
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

/** Returns cached things-to-do attractions for a city, bucketed by category. */
async function getCityAttractions(req, res, next) {
  try {
    const result = await cityService.getCityAttractions(req.params.slug);
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * Returns (or generates) an AI city snapshot for a city.
 * Checks the current review count first; regenerates if the summary is stale.
 */
async function getCitySummary(req, res, next) {
  try {
    const result = await getOrGenerateSummary(req.params.slug);
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * Returns the top 5 cities best matching a user's preference weights.
 * Body: { weights: { safety, affordability, walkability, cleanliness, environment }, state? }
 * Weights are 0–10; server normalises them to sum to 1.
 */
async function recommendCities(req, res, next) {
  try {
    const raw = req.body?.weights ?? {};
    const stateFilter = raw.state ? String(raw.state).trim().toUpperCase() : null;
    const sizeFilter = raw.sizePreference ? String(raw.sizePreference).trim().toLowerCase() : null;

    const result = await cityService.recommendCities({ rawWeights: raw, stateFilter, sizeFilter });
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { listCities, getCityBySlug, getCityDetails, getCityAttractions, getCitySummary, recommendCities };
