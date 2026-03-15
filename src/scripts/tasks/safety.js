const fs = require("fs");
const path = require("path");

const { db } = require("../../config/firebase");
const { clamp0to10 } = require("../../lib/numbers");
const { upsertCityMetrics } = require("../../utils/cityMetrics");
const { recomputeCityLivability } = require("../../utils/cityStats");

// Config
const YEARS_TO_AVG = 3;
const WEIGHT_VIOLENT = 3;
const WEIGHT_PROPERTY = 1;
// RATE_AT_ZERO: the weighted-average crime index (per 100k) at which safetyScore = 0.
// Calibrated for the weighted-average formula below (not weighted sum).
// US national violent ~380/100k, property ~2000/100k → weighted avg ≈ 785/100k → score ~6.9.
// High-crime CA city (e.g. violent 750, property 2500 per 100k) → weighted avg ≈ 1188 → score ~5.3.
const RATE_AT_ZERO = 2500;
const SAFETY_PIPELINE_VERSION = "syncSafetyFromCsv:v2";

// Path resolution
/** Resolves the CSV data directory: defaults to `<cwd>/src/data` when `dirArg` is falsy. */
function resolveDataDir(dirArg) {
  if (!dirArg) return path.join(process.cwd(), "src", "data");
  return path.isAbsolute(dirArg) ? dirArg : path.join(process.cwd(), dirArg);
}

// CSV parsing
/** Parses a single CSV line where every field is wrapped in double quotes. */
function parseQuotedCsvLine(line) {
  const fields = [];
  const re = /"([^"]*)"(?:,|$)/g;
  let m;
  while ((m = re.exec(line)) !== null) fields.push(m[1]);
  return fields;
}

/** Parses a count cell (possibly comma-formatted, e.g. `"1,234"`) to a finite number or `null`. */
function parseCount(cell) {
  if (cell == null) return null;
  const s = String(cell).trim();
  if (!s || s.toLowerCase() === "null") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert crimeIndexPer100k -> safety score (0–10).
 * RATE_AT_ZERO is the "very unsafe" threshold (score ~ 0).
 */
function computeSafetyScoreFromIndex(crimeIndexPer100k) {
  if (!Number.isFinite(crimeIndexPer100k)) return null;

  // 0..10 where 10 is safest
  const raw10 = 10 - (crimeIndexPer100k / RATE_AT_ZERO) * 10;

  return Math.round(clamp0to10(raw10) * 10) / 10;
}

/**
 * Parses crime CSV text into a structured object.
 * Expects a quoted-CSV format with a header row (first column = label, rest = years)
 * and data rows keyed by crime category label (e.g. "Violent Crimes").
 * @param {string} csvText
 * @returns {{ years: string[], rows: Map<string, string[]> }|null} null if the file is empty
 */
function readCrimeRowsFromCsv(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const header = parseQuotedCsvLine(lines[0]);
  const years = header
    .slice(1)
    .map((y) => String(y).trim())
    .filter(Boolean);

  const rows = new Map();
  for (let i = 1; i < lines.length; i++) {
    const fields = parseQuotedCsvLine(lines[i]);
    if (fields.length < 2) continue;
    const label = String(fields[0]).trim();
    const cells = fields.slice(1);
    rows.set(label, cells);
  }

  return { years, rows };
}

/**
 * Averages the last `n` finite values from `cells`, reading from the most recent year backward.
 * @param {string[]} years - year labels (used only for length; values traversed right-to-left)
 * @param {string[]|undefined} cells - raw cell values aligned to `years`
 * @param {number} n - number of years to average
 * @returns {{ avg: number|null, used: number }}
 */
function avgLastNYears(years, cells, n) {
  const values = [];
  for (let i = years.length - 1; i >= 0; i--) {
    const v = parseCount(cells?.[i]);
    if (Number.isFinite(v)) values.push(v);
    if (values.length >= n) break;
  }
  if (values.length === 0) return { avg: null, used: 0 };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { avg, used: values.length };
}

// Firestore helpers
/** Reads the stored population from `city_metrics`; returns `null` if missing or zero. */
async function getPopulation(cityId) {
  const snap = await db.collection("city_metrics").doc(cityId).get();
  if (!snap.exists) return null;
  const pop = Number(snap.data()?.population);
  return Number.isFinite(pop) && pop > 0 ? pop : null;
}

/**
 * Syncs safety scores from per-city CSV files into `city_metrics`.
 * Each CSV file must be named `<city-slug>.csv` and contain quoted rows for
 * "Violent Crimes" and "Property Crimes" with yearly count columns.
 * Uses a 3-year weighted average (3× violent + 1× property) normalized against population.
 * @param {{ dir?: string|null, dryRun?: boolean, verbose?: boolean }} [options]
 * @returns {Promise<{ touchedCityIds: string[] }>}
 */
async function taskSafety({ dir, dryRun = false, verbose = false } = {}) {
  const DATA_DIR = resolveDataDir(dir);

  const files = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".csv"))
    : [];

  if (files.length === 0) {
    console.log(`No CSV files found in ${DATA_DIR}`);
    return { touchedCityIds: [] };
  }

  const syncedAt = new Date().toISOString();
  const touchedCityIds = [];

  for (const file of files) {
    const cityId = file
      .replace(/\.csv$/i, "")
      .trim()
      .toLowerCase();
    const fullPath = path.join(DATA_DIR, file);
    const csvText = fs.readFileSync(fullPath, "utf8");

    const parsed = readCrimeRowsFromCsv(csvText);
    if (!parsed) {
      console.log(`[skip] ${cityId}: could not parse CSV`);
      continue;
    }

    const { years, rows } = parsed;

    if (rows.size === 0) {
      console.warn(
        `[warn] ${cityId}: CSV parsed 0 rows — file may use unquoted fields or an unexpected format (${file})`,
      );
      continue;
    }

    const violentCells = rows.get("Violent Crimes");
    const propertyCells = rows.get("Property Crimes");

    if (!violentCells || !propertyCells) {
      console.log(
        `[skip] ${cityId}: missing "Violent Crimes" or "Property Crimes" row`,
      );
      continue;
    }

    const population = await getPopulation(cityId);
    if (!population) {
      console.log(
        `[skip] ${cityId}: missing population in city_metrics/${cityId}`,
      );
      continue;
    }

    const violent = avgLastNYears(years, violentCells, YEARS_TO_AVG);
    const property = avgLastNYears(years, propertyCells, YEARS_TO_AVG);

    if (!Number.isFinite(violent.avg) || !Number.isFinite(property.avg)) {
      console.log(
        `[skip] ${cityId}: not enough numeric data in last ${YEARS_TO_AVG} years`,
      );
      continue;
    }

    // Weighted average (not sum): divide by total weight so the index represents
    // a per-crime-type rate rather than an inflated combined count.
    const weightedAvg =
      (violent.avg * WEIGHT_VIOLENT + property.avg * WEIGHT_PROPERTY) /
      (WEIGHT_VIOLENT + WEIGHT_PROPERTY);
    const crimeIndexPer100k = (weightedAvg / population) * 100000;
    const safetyScore = computeSafetyScoreFromIndex(crimeIndexPer100k);

    const patch = {
      safetyScore,
      crimeIndexPer100k: Number(crimeIndexPer100k.toFixed(2)),
      meta: {
        source: SAFETY_PIPELINE_VERSION,
        syncedAt,
        yearsAveraged: YEARS_TO_AVG,
        weights: { violent: WEIGHT_VIOLENT, property: WEIGHT_PROPERTY },
        rateAtZero: RATE_AT_ZERO,
        ...(verbose
          ? {
              debug: {
                years,
                violentUsed: violent.used,
                propertyUsed: property.used,
                file,
              },
            }
          : {}),
      },
    };

    if (dryRun) {
      console.log(`[dry-run] upsertCityMetrics ${cityId}`, patch);
    } else {
      await upsertCityMetrics(cityId, patch, { owner: "safetySync" });
      await recomputeCityLivability(cityId);
    }

    touchedCityIds.push(cityId);

    console.log(
      `[ok] ${cityId}: pop=${population} crimeIndexPer100k=${crimeIndexPer100k.toFixed(
        2,
      )} safetyScore=${safetyScore}`,
    );
  }

  console.log(`✅ safety done. Updated ${touchedCityIds.length} city/cities.`);
  return { touchedCityIds };
}

module.exports = { taskSafety, computeSafetyScoreFromIndex, readCrimeRowsFromCsv, avgLastNYears };
