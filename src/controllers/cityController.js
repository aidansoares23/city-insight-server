// src/controllers/cityController.js
const admin = require("firebase-admin");
const { db } = require("../config/firebase");
const { computeAveragesFromStats } = require("../utils/cityStats");
const { getCityMetrics } = require("../utils/cityMetrics");

function tsToIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate().toISOString();
  if (ts._seconds != null) return new Date(ts._seconds * 1000).toISOString();
  return null;
}

function withIsoTimestamps(obj) {
  if (!obj || typeof obj !== "object") return obj;
  return {
    ...obj,
    createdAtIso: tsToIso(obj.createdAt),
    updatedAtIso: tsToIso(obj.updatedAt),
  };
}

function normalizeCityIdFromParam(param) {
  return String(param ?? "")
    .trim()
    .toLowerCase();
}

function buildNextCursorFromDoc(doc) {
  const data = doc.data() || {};
  return { id: doc.id, createdAtIso: tsToIso(data.createdAt) };
}

function toFiniteOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Front end can display all cities with some facts
async function listCities(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);

    // Optional: simple search filter (client-side; fine for <=100 cities)
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();

    // Optional sorting
    const sort = String(req.query.sort || "name_asc")
      .trim()
      .toLowerCase();

    // 1) Base city docs
    const snap = await db
      .collection("cities")
      .orderBy("name", "asc")
      .limit(limit)
      .get();
    const baseCities = snap.docs.map((d) => {
      const data = d.data() || {};
      return {
        id: d.id, // equals slug in your schema
        slug: data.slug ?? d.id,
        name: data.name ?? null,
        state: data.state ?? null,
      };
    });

    // 2) Batch fetch stats + metrics using getAll (performance)
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

    // 3) Build card projection
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
        livabilityScore, // number (0–100-ish)
        safetyScore: metricsDoc?.safetyScore ?? null, // 0–100
        medianRent, // $
        crimeIndexPer100k: metricsDoc?.crimeIndexPer100k ?? null,
      };
    });

    // 4) Optional search
    if (q) {
      cities = cities.filter((c) => {
        const hay =
          `${c.name || ""} ${c.state || ""} ${c.slug || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    // 5) Optional sort
    const cmpNullLastDesc = (a, b) => {
      const av = toFiniteOrNull(a);
      const bv = toFiniteOrNull(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av;
    };
    const cmpNullLastAsc = (a, b) => {
      const av = toFiniteOrNull(a);
      const bv = toFiniteOrNull(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av - bv;
    };

    switch (sort) {
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

    return res.json({
      cities,
      meta: { limit, q: q || null, sort },
    });
  } catch (err) {
    next(err);
  }
}

async function getCityBySlug(req, res, next) {
  try {
    const cityId = normalizeCityIdFromParam(req.params.slug);
    const snap = await db.collection("cities").doc(cityId).get();

    if (!snap.exists) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "City not found" },
      });
    }

    return res.json({
      city: withIsoTimestamps({ id: snap.id, ...snap.data() }),
    });
  } catch (err) {
    next(err);
  }
}

async function getCityDetails(req, res, next) {
  try {
    const cityId = normalizeCityIdFromParam(req.params.slug);

    // City
    const citySnap = await db.collection("cities").doc(cityId).get();
    if (!citySnap.exists) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "City not found" },
      });
    }

    // city_stats: review aggregates + livability
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

    // city_metrics: objective metrics
    const metrics = await getCityMetrics(cityId);

    const livability =
      statsDoc?.livability && typeof statsDoc.livability === "object"
        ? statsDoc.livability
        : { score: null, version: "uncomputed" };

    // -------------------------
    // Latest reviews (PUBLIC-SAFE preview)
    // -------------------------
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
        // TODO: MAKE SURE THIS IS OK
        // id: d.id,
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

    // const cityData = citySnap.data() || {};
    // const city = {
    //   id: citySnap.id,
    //   slug: cityData.slug,
    //   name: cityData.name,
    //   state: cityData.state,
    //   lat: cityData.lat,
    //   lng: cityData.lng,
    // };
    const cityData = citySnap.data() || {};
    const city = {
      id: citySnap.id,
      slug: cityData.slug ?? citySnap.id,
      name: cityData.name ?? null,
      state: cityData.state ?? null,
      lat: cityData.lat ?? null,
      lng: cityData.lng ?? null,

      // NEW: description fields for the details page
      tagline: cityData.tagline ?? null,
      description: cityData.description ?? null,
      highlights: Array.isArray(cityData.highlights) ? cityData.highlights : [],

      // Optional (nice for debugging / UI later)
      createdAtIso: tsToIso(cityData.createdAt),
      updatedAtIso: tsToIso(cityData.updatedAt),
    };

    return res.json({
      city,
      stats,
      metrics,
      livability,
      reviews,
      reviewsPage: { pageSize, nextCursor },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listCities,
  getCityBySlug,
  getCityDetails,
};
