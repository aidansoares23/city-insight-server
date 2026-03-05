// src/controllers/cityController.js
const { withIsoTimestamps } = require("../lib/firestore");
const cityService = require("../services/cityService");

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

async function getCityBySlug(req, res, next) {
  try {
    const found = await cityService.getCityBySlug(req.params.slug);
    return res.json({
      city: withIsoTimestamps({ id: found.id, ...found.data }),
    });
  } catch (err) {
    next(err);
  }
}

async function getCityDetails(req, res, next) {
  try {
    const result = await cityService.getCityDetails(req.params.slug);
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { listCities, getCityBySlug, getCityDetails };
