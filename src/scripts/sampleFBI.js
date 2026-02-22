// src/scripts/syncSafetyFromFbi.js

const fetch = require("node-fetch");

const { initAdmin } = require("./lib/initAdmin");
initAdmin();

const { upsertCityMetrics } = require("../utils/cityMetrics");
const { recomputeCityLivability } = require("../utils/cityStats");

const API_KEY = process.env.FBI_API_KEY;

// ✅ Correct CDE base
const API_BASE = "https://api.usa.gov/crime/fbi/cde/LATEST";

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

async function readResponseText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarizeBody(text, max = 500) {
  const t = String(text ?? "");
  return t.length <= max ? t : t.slice(0, max) + "…";
}

// -----------------------------
// Parse CDE response
// -----------------------------

function pickViolentTotal(data) {
  // CDE summarized/agency response usually returns array of yearly objects
  // Example shape:
  // [
  //   {
  //     data_year: 2022,
  //     violent_crime: 1234,
  //     homicide: ...
  //   }
  // ]

  if (!Array.isArray(data) || data.length === 0) return null;

  // Grab most recent year
  const latest = [...data].sort(
    (a, b) => Number(b.data_year) - Number(a.data_year),
  )[0];

  if (!latest) return null;

  const direct = Number(latest.violent_crime);
  if (Number.isFinite(direct)) return direct;

  const fields = ["aggravated_assault", "robbery", "rape", "homicide"];

  const nums = fields
    .map((k) => Number(latest[k]))
    .filter((n) => Number.isFinite(n));

  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

// -----------------------------
// Fetch with retry
// -----------------------------

async function fetchJsonWithRetry(url, { retries = 4 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Api-Key": API_KEY, // ✅ correct casing
        },
      });

      const text = await readResponseText(res);
      const bodyJson = parseJsonSafe(text);

      if (res.ok) {
        if (!bodyJson) {
          throw new Error(`OK but non-JSON response :: ${summarizeBody(text)}`);
        }
        return bodyJson;
      }

      const retryable =
        res.status === 503 ||
        res.status === 429 ||
        res.status === 502 ||
        res.status === 504;

      if (retryable && attempt < retries) {
        const backoff = 750 * 2 ** attempt;
        console.warn(`[FBI] HTTP ${res.status}, retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      throw new Error(`FBI HTTP ${res.status} :: ${summarizeBody(text)}`);
    } catch (err) {
      if (attempt < retries) {
        const backoff = 750 * 2 ** attempt;
        console.warn(`[FBI] network error, retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}

// -----------------------------
// CDE wrapper
// -----------------------------

function buildUrl(path, query = {}) {
  const u = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function fetchAgencyOffenseSummary({ ori, offense }) {
  if (!API_KEY) {
    throw new Error("Missing FBI_API_KEY in environment variables");
  }

  const url = buildUrl(
    `/summarized/agency/${encodeURIComponent(ori)}/${encodeURIComponent(
      offense,
    )}`,
  );

  console.log("[FBI] GET", url);
  return fetchJsonWithRetry(url);
}

// -----------------------------
// Main
// -----------------------------

async function main() {
  console.log("=== syncSafetyFromFbi (CDE) ===");

  const cityOriMap = {
    "san-francisco-ca": "CA0380100",
    "los-angeles-ca": "CA0194200",
    // add others here
  };

  for (const cityId of CITY_IDS) {
    const ori = cityOriMap[cityId];

    if (!ori) {
      console.log(`Skipping ${cityId} (no ORI mapping)`);
      continue;
    }

    try {
      const data = await fetchAgencyOffenseSummary({
        ori,
        offense: "violent-crime",
      });

      const violentTotal = pickViolentTotal(data);

      await upsertCityMetrics(
        cityId,
        {
          violentCrimeTotal: violentTotal,
          meta: {
            source: "fbi-cde",
            ori,
            syncedAt: nowIso(),
          },
        },
        { owner: "safetySync" },
      );

      await recomputeCityLivability(cityId);

      console.log(
        `Updated ${cityId} (ORI ${ori}) with violent crime ${violentTotal}`,
      );
    } catch (err) {
      console.error(`Failed ${cityId} (ORI ${ori})`);
      console.error(err.message || err);
    }
  }
}

main().catch((err) => {
  console.error("Fatal script error:");
  console.error(err);
});
