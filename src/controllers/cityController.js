// src/controllers/cityController.js
const { withIsoTimestamps } = require("../lib/firestore");
const cityService = require("../services/cityService");

async function listCities(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();
    const sort = String(req.query.sort || "name_asc")
      .trim()
      .toLowerCase();

    const result = await cityService.listCities({ limit, q, sort });
    return res.json(result);
  } catch (err) {
    next(err);
  }
}

async function getCityBySlug(req, res, next) {
  try {
    const found = await cityService.getCityBySlug(req.params.slug);
    if (!found) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "City not found" },
      });
    }
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

module.exports = { listCities, getCityBySlug, getCityDetails };
