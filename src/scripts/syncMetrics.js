// src/scripts/syncMetrics.js
// Run: node src/scripts/syncMetrics.js
//
// What it does:
// - Fetches CA place population + median gross rent from the US Census ACS API
// - Upserts city_metrics docs with fields this script owns: population + medianGrossRent
// - Recomputes livability for touched cities
//
// Notes:
// - This does NOT write safetyScore / crimeIndexPer100k (owned by syncSafetyFromCsv.js)
// - Uses upsertCityMetrics(..., { owner: "metricsSync" }) to prevent accidental clobbering.

const { initAdmin } = require("./lib/initAdmin");
initAdmin();

const { admin } = require("../config/firebase");
const { upsertCityMetrics } = require("../utils/cityMetrics");
const { recomputeCityLivability } = require("../utils/cityStats");

// If you're on Node 18+, you can remove this and use global fetch.
const fetch = require("node-fetch");

// -----------------------------
// Config
// -----------------------------
const ACS_YEAR = "2022";
const ACS_DATASET = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5`;

// Population + Median Gross Rent + NAME
const ACS_VARS = ["B01003_001E", "B25064_001E", "NAME"];

// California
const ACS_GEO = "&for=place:*&in=state:06";

// Only update the cities you care about
const CITY_IDS = [
  "san-francisco-ca",
  "san-jose-ca",
  "los-angeles-ca",
  "san-diego-ca",
  "sacramento-ca",
];

// -----------------------------
// Helpers
// -----------------------------
function toNumOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Convert Census NAME -> your slug format.
// "San Francisco city, California" -> "san-francisco-ca"
function censusNameToSlug(name) {
  const cleaned = String(name).trim();
  const withoutSuffix = cleaned
    .replace(/\s+(city|town|village|CDP)\s*,\s*California\s*$/i, "")
    .replace(/\s*,\s*California\s*$/i, "");
  return withoutSuffix.toLowerCase().replace(/\s+/g, "-") + "-ca";
}

// -----------------------------
// Census fetch
// -----------------------------
async function fetchAcsPlacesCA() {
  const url = `${ACS_DATASET}?get=${ACS_VARS.join(",")}${ACS_GEO}`;

  console.log("\n--- ACS Fetch ---");
  console.log("Calling Census ACS API:");
  console.log(url);

  const res = await fetch(url);
  console.log("ACS status:", res.status);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("ACS error body (maybe empty):", body.slice(0, 500));
    throw new Error(`ACS API failed: ${res.status}`);
  }

  const rows = await res.json();

  console.log("Raw ACS rows (first 5):");
  console.log(rows.slice(0, 5));

  const header = rows[0];
  const data = rows.slice(1);

  console.log("Header:", header);

  const idxPop = header.indexOf("B01003_001E");
  const idxRent = header.indexOf("B25064_001E");
  const idxName = header.indexOf("NAME");

  console.log("Index(pop):", idxPop, "Index(rent):", idxRent, "Index(name):", idxName);

  if (idxPop < 0 || idxRent < 0 || idxName < 0) {
    throw new Error("Unexpected ACS response: missing one of B01003_001E, B25064_001E, NAME");
  }

  return data.map((r) => ({
    name: r[idxName],
    population: toNumOrNull(r[idxPop]),
    medianGrossRent: toNumOrNull(r[idxRent]),
  }));
}

// -----------------------------
// Main
// -----------------------------
async function main() {
  console.log("\n=== syncMetrics (ACS pop + medianGrossRent) ===");

  // 1) Fetch ACS for CA places
  const acsRows = await fetchAcsPlacesCA();
  console.log(`Fetched ${acsRows.length} CA places from ACS.`);

  // 2) Build slug map for fast lookup
  const bySlug = new Map();
  for (const row of acsRows) {
    const slug = censusNameToSlug(row.name);
    bySlug.set(slug, row);

    // debug: only show the cities we care about
    if (CITY_IDS.includes(slug)) {
      console.log("\nMapped ACS row (used):");
      console.log("  name:", row.name);
      console.log("  slug:", slug);
      console.log("  population:", row.population);
      console.log("  medianGrossRent:", row.medianGrossRent);
    }
  }

  // 3) Write city_metrics (safe field ownership)
  console.log("\n--- Firestore Writes: city_metrics (owned: metricsSync) ---");

  const touched = [];

  for (const cityId of CITY_IDS) {
    const row = bySlug.get(cityId);

    if (!row) {
      console.log(`[skip] No ACS match for ${cityId} (keeping existing Firestore values)`);
      continue;
    }

    const patch = {
      population: toNumOrNull(row.population),
      medianGrossRent: toNumOrNull(row.medianGrossRent),
      meta: {
        source: `acs${ACS_YEAR}:B01003+B25064`,
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    };

    console.log("Upserting metrics:", cityId, patch);

    // IMPORTANT: owner is passed as options (3rd argument), not inside patch.
    // await upsertCityMetrics(cityId, patch, { owner: "metricsSync" });
    await upsertCityMetrics(cityId, {
      population: row.population,
      medianRent: row.medianGrossRent, // from ACS B25064_001E
      meta: { source: `acs${ACS_YEAR}:B01003+B25064`, syncedAt: new Date().toISOString() },
    }, { owner: "metricsSync" });


    touched.push(cityId);
  }

  // 4) Recompute livability for touched cities (metrics changed)
  console.log("\n--- Recompute Livability ---");
  for (const cityId of touched) {
    const livability = await recomputeCityLivability(cityId);
    console.log(`[livability] ${cityId}:`, livability);
  }

  console.log(`\n✅ Synced metrics (ACS) for ${touched.length} city/cities and recomputed livability.\n`);
}

main().catch((e) => {
  console.error("❌ syncMetrics failed:", e);
  process.exitCode = 1;
});
