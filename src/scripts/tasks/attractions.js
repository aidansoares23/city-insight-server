const { db, admin } = require("../../config/firebase");
const { fetchAllCategoryPlaces } = require("../../services/foursquareService");

const SLEEP_MS = 5000; // 5s between cities — Overpass is a shared free service, be polite

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Syncs "things to do" attractions from the Overpass (OpenStreetMap) API into `city_attractions`.
 * Each city gets up to 5 attractions per category bucket: attractions, restaurants, outdoors, nightlife.
 * Run this once to populate; re-run to refresh.
 * @param {{ cities?: string[]|null, dryRun?: boolean, verbose?: boolean }} [options]
 * @returns {Promise<{ touchedCityIds: string[] }>}
 */
async function taskAttractions({ cities, dryRun = false, verbose = false } = {}) {
  console.log("=== attractions (Overpass / OpenStreetMap) ===");

  const snap = await db.collection("cities").get();
  const allCityDocs = snap.docs.map((doc) => ({
    id:  doc.id,
    lat: doc.data()?.lat ?? null,
    lng: doc.data()?.lng ?? null,
  }));

  const targetIds = cities ? new Set(cities) : null;
  const cityDocs  = targetIds
    ? allCityDocs.filter((c) => targetIds.has(c.id))
    : allCityDocs;

  const syncedAtIso = new Date().toISOString();
  const touchedCityIds = [];

  for (const city of cityDocs) {
    if (city.lat == null || city.lng == null) {
      console.log(`[attractions] skip (no lat/lng): ${city.id}`);
      continue;
    }

    let categories;
    try {
      categories = await fetchAllCategoryPlaces(city.lat, city.lng, { limit: 5 });
    } catch (err) {
      console.error(`[attractions] fetch failed (${city.id}):`, err.message);
      continue;
    }

    if (verbose) {
      const counts = Object.entries(categories)
        .map(([k, v]) => `${k}=${v.length}`)
        .join(" ");
      console.log(`[attractions] ${city.id}: ${counts}`);
    }

    const doc = {
      cityId:      city.id,
      syncedAtIso,
      source:      "overpass:v1",
      categories,
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    };

    if (dryRun) {
      const counts = Object.entries(categories)
        .map(([k, v]) => `${k}=${v.length}`)
        .join(" ");
      console.log(`[dry-run][attractions] would write ${city.id}: ${counts}`);
    } else {
      await db.collection("city_attractions").doc(city.id).set(doc);
    }

    touchedCityIds.push(city.id);
    console.log(`[ok] ${city.id}`);

    await sleep(SLEEP_MS);
  }

  console.log(`✅ attractions done. Updated ${touchedCityIds.length}/${cityDocs.length} cities.`);
  return { touchedCityIds };
}

module.exports = { taskAttractions };
