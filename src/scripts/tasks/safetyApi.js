const { db } = require("../../config/firebase");
const { fetchAgenciesByState, fetchOffenseRates } = require("../../services/fbiService");
const { upsertCityMetrics } = require("../../utils/cityMetrics");
const { recomputeCityLivability } = require("../../utils/cityStats");
const { clamp0to10, toNumOrNull } = require("../../lib/numbers");

// Match the existing safety.js calibration for score consistency.
const YEARS_TO_AVG    = 3;
const WEIGHT_VIOLENT  = 3;
const WEIGHT_PROPERTY = 1;
const RATE_AT_ZERO    = 2500; // per-100k weighted avg that maps to safetyScore = 0
const FROM_YEAR       = 2020;
const TO_YEAR         = 2023;

const PIPELINE_VERSION = "syncSafetyFromFbi:v1";

/** Converts crimeIndexPer100k -> safety score (0–10). */
function computeSafetyScore(crimeIndexPer100k) {
  if (!Number.isFinite(crimeIndexPer100k)) return null;
  const raw = 10 - (crimeIndexPer100k / RATE_AT_ZERO) * 10;
  return Math.round(clamp0to10(raw) * 10) / 10;
}

/**
 * Averages monthly per-100k rates across the most recent `n` calendar years.
 * Rates map is keyed "MM-YYYY" → number.
 * @param {Record<string, number>} ratesMap
 * @param {number} n - number of most-recent years to include
 * @param {number} toYear - most recent year
 * @returns {{ avg: number|null, yearsUsed: number[] }}
 */
function avgAnnualRate(ratesMap, n, toYear) {
  const totals = [];
  for (let yr = toYear; yr > toYear - n; yr--) {
    const monthlyValues = Object.entries(ratesMap)
      .filter(([key]) => key.endsWith(`-${yr}`))
      .map(([, v]) => toNumOrNull(v))
      .filter((v) => v !== null);

    if (monthlyValues.length === 0) continue;
    const annualAvg = monthlyValues.reduce((a, b) => a + b, 0) / monthlyValues.length;
    totals.push({ year: yr, avg: annualAvg });
  }

  if (totals.length === 0) return { avg: null, yearsUsed: [] };
  const monthlyAvg = totals.reduce((a, b) => a + b.avg, 0) / totals.length;
  // Annualize: FBI rates are monthly per 100k; RATE_AT_ZERO is calibrated for annual rates.
  return { avg: monthlyAvg * 12, yearsUsed: totals.map((t) => t.year) };
}

/**
 * Strips law enforcement suffixes from an agency name to extract the city name.
 * e.g. "Portland Police Department" → "portland"
 *      "Salem Police Bureau"        → "salem"
 */
function cityNameFromAgency(agencyName) {
  return String(agencyName)
    .replace(/\s+(Police|Department of Public Safety|Public Safety).*/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Syncs safety scores from the FBI Crime Data Explorer API into `city_metrics`.
 * The FBI API returns rates already normalized per 100k, so no population lookup is needed.
 * Matches cities to FBI "City" type agencies by extracting the city name from agency_name.
 * Run the `metrics` task first to ensure population data exists (used only for logging here).
 * @param {{ cities?: string[]|null, dryRun?: boolean, verbose?: boolean }} [options]
 * @returns {Promise<{ touchedCityIds: string[] }>}
 */
async function taskSafetyApi({ cities, dryRun = false, verbose = false } = {}) {
  console.log(`=== safety-api (FBI CDE ${FROM_YEAR}–${TO_YEAR}) ===`);

  const snap = await db.collection("cities").get();
  const allCityDocs = snap.docs.map((doc) => ({
    id:    doc.id,
    name:  doc.data()?.name  ?? null,
    state: doc.data()?.state ?? null,
  }));

  const targetIds = cities ? new Set(cities) : null;
  const cityDocs  = targetIds
    ? allCityDocs.filter((c) => targetIds.has(c.id))
    : allCityDocs;

  // Group by state so we fetch agencies once per state.
  const byState = new Map();
  for (const city of cityDocs) {
    const abbr = String(city.state || "").trim().toUpperCase();
    if (!abbr) {
      console.log(`[safety-api] skip (no state): ${city.id}`);
      continue;
    }
    if (!byState.has(abbr)) byState.set(abbr, []);
    byState.get(abbr).push(city);
  }

  const syncedAt = new Date().toISOString();
  const touchedCityIds = [];

  for (const [stateAbbr, stateCities] of byState) {
    let agencies;
    try {
      agencies = await fetchAgenciesByState(stateAbbr);
    } catch (err) {
      console.error(`[safety-api] agencies fetch failed (${stateAbbr}):`, err.message);
      continue;
    }

    // Index City-type agencies by normalized city name; last write wins on dupes.
    const agencyByCity = new Map();
    for (const agency of agencies) {
      if (agency.agency_type_name !== "City") continue;
      const key = cityNameFromAgency(agency.agency_name);
      agencyByCity.set(key, agency);
    }

    for (const city of stateCities) {
      const key    = String(city.name || "").toLowerCase().trim();
      const agency = agencyByCity.get(key);

      if (!agency) {
        console.log(`[safety-api] skip (no FBI city agency match): ${city.id}`);
        continue;
      }

      if (verbose) {
        console.log(`[safety-api] ${city.id} → ORI ${agency.ori} (${agency.agency_name})`);
      }

      let violentRates, propertyRates;
      try {
        [violentRates, propertyRates] = await Promise.all([
          fetchOffenseRates(agency.ori, "violent-crime",  agency.agency_name, FROM_YEAR, TO_YEAR),
          fetchOffenseRates(agency.ori, "property-crime", agency.agency_name, FROM_YEAR, TO_YEAR),
        ]);
      } catch (err) {
        console.error(`[safety-api] offense fetch failed (${agency.ori}):`, err.message);
        continue;
      }

      if (!violentRates || !propertyRates) {
        console.log(`[safety-api] skip (no offense rate data): ${city.id}`);
        continue;
      }

      const violent  = avgAnnualRate(violentRates,  YEARS_TO_AVG, TO_YEAR);
      const property = avgAnnualRate(propertyRates, YEARS_TO_AVG, TO_YEAR);

      if (violent.avg == null || property.avg == null) {
        console.log(`[safety-api] skip (insufficient rate data): ${city.id}`);
        continue;
      }

      // Weighted average of per-100k rates — directly comparable to RATE_AT_ZERO.
      const crimeIndexPer100k =
        (violent.avg * WEIGHT_VIOLENT + property.avg * WEIGHT_PROPERTY) /
        (WEIGHT_VIOLENT + WEIGHT_PROPERTY);
      const safetyScore = computeSafetyScore(crimeIndexPer100k);

      const patch = {
        safetyScore,
        crimeIndexPer100k: Number(crimeIndexPer100k.toFixed(2)),
        meta: {
          source:     PIPELINE_VERSION,
          syncedAt,
          ori:        agency.ori,
          agencyName: agency.agency_name,
          yearsUsed:  { violent: violent.yearsUsed, property: property.yearsUsed },
          weights:    { violent: WEIGHT_VIOLENT, property: WEIGHT_PROPERTY },
          rateAtZero: RATE_AT_ZERO,
        },
      };

      if (dryRun) {
        console.log(`[dry-run][safety-api] would upsert ${city.id}`, patch);
      } else {
        await upsertCityMetrics(city.id, patch, { owner: "safetySync" });
        await recomputeCityLivability(city.id);
      }

      touchedCityIds.push(city.id);
      console.log(
        `[ok] ${city.id}: crimeIndexPer100k=${crimeIndexPer100k.toFixed(2)} safetyScore=${safetyScore}`,
      );
    }
  }

  console.log(`✅ safety-api done. Updated ${touchedCityIds.length}/${cityDocs.length} cities.`);
  return { touchedCityIds };
}

module.exports = { taskSafetyApi };
