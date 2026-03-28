const { upsertCityMetrics } = require("../../utils/cityMetrics");
const { recomputeCityLivability } = require("../../utils/cityStats");
const { db } = require("../../config/firebase");
const { fetchAcsPlacesByState, ACS_YEAR } = require("../../services/censusService");
const { censusNameToStateSlug } = require("../../lib/slugs");

/**
 * Syncs population and median rent from the Census ACS API into `city_metrics`.
 * Groups cities by state and issues one ACS request per unique state.
 * Matches ACS place names to city slugs via `censusNameToStateSlug`; unmatched cities are skipped.
 * Triggers a livability recompute after each successful upsert.
 * @param {{ cities?: string[]|null, dryRun?: boolean, verbose?: boolean }} [options]
 * @returns {Promise<{ touchedCityIds: string[] }>}
 */
async function taskMetrics({ cities, dryRun = false, verbose = false } = {}) {
  console.log(`=== metrics (ACS ${ACS_YEAR}) ===`);

  // Load city docs to get name + state for each slug we care about.
  const snap = await db.collection("cities").get();
  const allCityDocs = snap.docs.map((doc) => ({
    id: doc.id,
    name: doc.data()?.name ?? null,
    state: doc.data()?.state ?? null,
  }));

  const targetIds = cities ? new Set(cities) : null;
  const cityDocs = targetIds
    ? allCityDocs.filter((c) => targetIds.has(c.id))
    : allCityDocs;

  // Group by state so we make one ACS request per state.
  const byState = new Map();
  for (const city of cityDocs) {
    const abbr = String(city.state || "").trim().toUpperCase();
    if (!abbr) {
      console.log(`[metrics] skip (no state): ${city.id}`);
      continue;
    }
    if (!byState.has(abbr)) byState.set(abbr, []);
    byState.get(abbr).push(city);
  }

  const touchedCityIds = [];

  for (const [stateAbbr, stateCities] of byState) {
    let acsRows;
    try {
      acsRows = await fetchAcsPlacesByState(stateAbbr);
    } catch (err) {
      console.error(`[metrics] ACS fetch failed for ${stateAbbr}:`, err.message);
      continue;
    }

    // Build slug -> row map for fast lookups.
    const bySlug = new Map();
    for (const r of acsRows) {
      const slug = censusNameToStateSlug(r.name, stateAbbr);
      bySlug.set(slug, r);
    }

    for (const city of stateCities) {
      const row = bySlug.get(city.id);
      if (!row) {
        console.log(`[metrics] skip (not found in ACS ${stateAbbr}): ${city.id}`);
        continue;
      }

      const patch = {
        population: row.population,
        medianRent: row.medianRent,
        meta: {
          source: `acs:${ACS_YEAR}`,
          syncedAtIso: new Date().toISOString(),
          version: `acs:${ACS_YEAR}:v1`,
        },
      };

      if (dryRun) {
        console.log(`[dry-run][metrics] would upsert ${city.id}`, patch);
        touchedCityIds.push(city.id);
        continue;
      }

      await upsertCityMetrics(city.id, patch, { owner: "metricsSync" });
      await recomputeCityLivability(city.id);

      touchedCityIds.push(city.id);
      if (verbose) console.log(`[metrics] updated ${city.id}`);
    }
  }

  console.log(`✅ metrics done. Updated ${touchedCityIds.length}/${cityDocs.length} cities.`);
  return { touchedCityIds };
}

module.exports = { taskMetrics };
