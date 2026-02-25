// src/scripts/tasks/safety.js
const fs = require("fs");
const path = require("path");

const { db } = require("../../config/firebase");
const { upsertCityMetrics } = require("../../utils/cityMetrics");
const { recomputeCityLivability } = require("../../utils/cityStats");

// -----------------------------
// Config (tune later)
// -----------------------------
const YEARS_TO_AVG = 3;
const WEIGHT_VIOLENT = 3;
const WEIGHT_PROPERTY = 1;
const RATE_AT_ZERO = 8000;
const SAFETY_PIPELINE_VERSION = "syncSafetyFromCsv:v1";

// -----------------------------
// Path resolution (task-friendly)
// -----------------------------
function resolveDataDir(dirArg) {
  if (!dirArg) return path.join(process.cwd(), "src", "data");
  return path.isAbsolute(dirArg) ? dirArg : path.join(process.cwd(), dirArg);
}

// -----------------------------
// CSV parsing helpers (same logic as syncSafetyFromCsv.js)
// -----------------------------
function parseQuotedCsvLine(line) {
  const fields = [];
  const re = /"([^"]*)"(?:,|$)/g;
  let m;
  while ((m = re.exec(line)) !== null) fields.push(m[1]);
  return fields;
}

function parseCount(cell) {
  if (cell == null) return null;
  const s = String(cell).trim();
  if (!s || s.toLowerCase() === "null") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function clamp0to10(n) {
  return Math.max(0, Math.min(10, n));
}

/**
 * Convert crimeIndexPer100k -> safety score (0–10).
 * RATE_AT_ZERO is the "very unsafe" threshold (score ~ 0).
 */
function computeSafetyScoreFromIndex(crimeIndexPer100k) {
  if (!Number.isFinite(crimeIndexPer100k)) return null;

  // 0..10 where 10 is safest
  const raw10 = 10 - (crimeIndexPer100k / RATE_AT_ZERO) * 10;

  // choose one:
  // return Math.round(clamp0to10(raw10));             // integer 0–10
  return Math.round(clamp0to10(raw10) * 10) / 10; // 1 decimal (recommended)
}

// function computeSafetyScoreFromIndex(crimeIndexPer100k) {
//   if (!Number.isFinite(crimeIndexPer100k)) return null;
//   const raw = 100 - (crimeIndexPer100k / RATE_AT_ZERO) * 100;
//   return Math.round(clamp0to100(raw));
// }

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

// -----------------------------
// Firestore helpers
// -----------------------------
async function getPopulation(cityId) {
  const snap = await db.collection("city_metrics").doc(cityId).get();
  if (!snap.exists) return null;
  const pop = Number(snap.data()?.population);
  return Number.isFinite(pop) && pop > 0 ? pop : null;
}

// -----------------------------
// Task entry
// -----------------------------
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

    const weightedAvg =
      violent.avg * WEIGHT_VIOLENT + property.avg * WEIGHT_PROPERTY;
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

module.exports = { taskSafety };
