const { withIsoTimestamps } = require("../lib/firestore");
const cityService = require("../services/cityService");

/** Returns a filtered, sorted list of cities; accepts `limit`, `q` (search), and `sort` query params. */
async function listCities(req, res, next) {
  try {
    const result = await cityService.listCities({
      limit: req.query.limit,
      q: req.query.q,
      sort: req.query.sort,
    });
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

/** Returns a single city document by slug with ISO timestamps; 404s if not found. */
async function getCityBySlug(req, res, next) {
  try {
    const cityDoc = await cityService.getCityBySlug(req.params.slug);
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
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { listCities, getCityBySlug, getCityDetails };
