const { db } = require("../../config/firebase");
const { fetchCityAirQuality } = require("../../services/airQualityService");
const { upsertCityMetrics } = require("../../utils/cityMetrics");

const SLEEP_MS = 4000; // Respect OpenAQ rate limits

/**
 * Syncs air quality data (PM2.5 → AQI) from OpenAQ into `city_metrics`.
 * No API key required. Run `livability --all` afterwards to propagate score changes.
 * @param {{ cities?: string[]|null, dryRun?: boolean, verbose?: boolean }} options
 */
async function taskAirQuality({ cities, dryRun = false, verbose = false } = {}) {
  console.log("=== air-quality (OpenAQ v3) ===");

  const snap = await db.collection("cities").get();
  const allCityDocs = snap.docs.map((doc) => ({
    id: doc.id,
    name: doc.data()?.name ?? doc.id,
    state: doc.data()?.state ?? null,
    lat: doc.data()?.lat ?? null,
    lng: doc.data()?.lng ?? null,
  }));

  const targetIds = cities ? new Set(cities) : null;
  const cityDocs = targetIds ? allCityDocs.filter((c) => targetIds.has(c.id)) : allCityDocs;

  console.log(`Processing ${cityDocs.length} cities…`);

  const touchedCityIds = [];
  let skipped = 0;

  for (const city of cityDocs) {
    process.stdout.write(`[air-quality] ${city.id} … `);
    if (!Number.isFinite(city.lat) || !Number.isFinite(city.lng)) {
      console.log("skipped (no coordinates)");
      skipped++;
      continue;
    }
    let result;
    try {
      result = await fetchCityAirQuality(city.lat, city.lng);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      skipped++;
      await new Promise((r) => setTimeout(r, SLEEP_MS));
      continue;
    }

    if (!result) {
      console.log("no data");
      skipped++;
      await new Promise((r) => setTimeout(r, SLEEP_MS));
      continue;
    }

    const patch = {
      aqiValue: result.aqiValue,
      pm25Avg: result.pm25Avg,
      meta: {
        source: "openaq:v3",
        syncedAtIso: new Date().toISOString(),
      },
    };

    if (dryRun) {
      console.log(`[dry-run] would set AQI=${result.aqiValue}, PM2.5=${result.pm25Avg}`);
    } else {
      await upsertCityMetrics(city.id, patch, { owner: "airQualitySync" });
      console.log(`AQI=${result.aqiValue}, PM2.5=${result.pm25Avg}`);
    }
    touchedCityIds.push(city.id);

    await new Promise((r) => setTimeout(r, SLEEP_MS));
  }

  console.log(
    `✅ air-quality done. Updated: ${touchedCityIds.length}, Skipped/failed: ${skipped} / ${cityDocs.length} cities.`,
  );
  return { touchedCityIds };
}

module.exports = { taskAirQuality };
