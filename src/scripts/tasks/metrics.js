// src/scripts/tasks/metrics.js
const fetch = require("node-fetch");
const { upsertCityMetrics } = require("../../utils/cityMetrics");
const { recomputeCityLivability } = require("../../utils/cityStats");
const { db } = require("../../config/firebase");
const { toNumOrNull } = require("../../lib/numbers");
const { censusNameToSlug } = require("../../lib/slugs");

console.log("[debug] metrics task loaded from:", __filename);

const ACS_YEAR = "2022";
const ACS_DATASET = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5`;
const ACS_VARS = ["B01003_001E", "B25064_001E", "NAME"];
const ACS_GEO = "&for=place:*&in=state:06";

async function fetchAcsPlacesCA() {
  const url = `${ACS_DATASET}?get=${ACS_VARS.join(",")}${ACS_GEO}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ACS API failed: ${res.status}`);
  const rows = await res.json();

  const header = rows[0];
  const data = rows.slice(1);

  const idxPop = header.indexOf("B01003_001E");
  const idxRent = header.indexOf("B25064_001E");
  const idxName = header.indexOf("NAME");
  if (idxPop < 0 || idxRent < 0 || idxName < 0)
    throw new Error("Unexpected ACS response shape");

  return data.map((r) => ({
    name: r[idxName],
    population: toNumOrNull(r[idxPop]),
    medianRent: toNumOrNull(r[idxRent]),
  }));
}

async function taskMetrics({ cities, dryRun = false, verbose = false } = {}) {
  let cityIds = cities;

  if (!cityIds || cityIds.length === 0) {
    // default: all cities in Firestore
    const snap = await db.collection("cities").get();
    cityIds = snap.docs.map((d) => d.id);
  }

  console.log(`=== metrics (ACS ${ACS_YEAR}) ===`);
  const acsRows = await fetchAcsPlacesCA();

  const bySlug = new Map();
  for (const r of acsRows) {
    const slug = censusNameToSlug(r.name);
    bySlug.set(slug, r);
  }

  const touchedCityIds = [];

  for (const cityId of cityIds) {
    const row = bySlug.get(cityId);
    if (!row) {
      if (verbose) console.log(`[metrics] skip (not found in ACS): ${cityId}`);
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
      console.log(`[dry-run][metrics] would upsert ${cityId}`, patch);
      touchedCityIds.push(cityId);
      continue;
    }

    await upsertCityMetrics(cityId, patch, { owner: "metricsSync" });
    await recomputeCityLivability(cityId);

    touchedCityIds.push(cityId);
    if (verbose) console.log(`[metrics] updated ${cityId}`);
  }

  return { touchedCityIds };
}

module.exports = { taskMetrics };
