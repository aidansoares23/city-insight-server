/**
 * Air quality data from OpenAQ API v3 (https://api.openaq.org/v3/).
 * Requires a free API key from https://explore.openaq.org/register (set OPENAQ_API_KEY env var).
 * Fetches PM2.5 readings for city monitoring stations and converts to the EPA AQI scale (0–500).
 */

const { OPENAQ_API_KEY } = require("../config/env");
const OPENAQ_BASE = "https://api.openaq.org/v3";
const FETCH_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// EPA PM2.5 → AQI breakpoints (https://www.epa.gov/aqi)
// ---------------------------------------------------------------------------
const AQI_BREAKPOINTS = [
  { pmLow:   0.0, pmHigh:  12.0, aqiLow:   0, aqiHigh:  50 },
  { pmLow:  12.1, pmHigh:  35.4, aqiLow:  51, aqiHigh: 100 },
  { pmLow:  35.5, pmHigh:  55.4, aqiLow: 101, aqiHigh: 150 },
  { pmLow:  55.5, pmHigh: 150.4, aqiLow: 151, aqiHigh: 200 },
  { pmLow: 150.5, pmHigh: 250.4, aqiLow: 201, aqiHigh: 300 },
  { pmLow: 250.5, pmHigh: 350.4, aqiLow: 301, aqiHigh: 400 },
  { pmLow: 350.5, pmHigh: 500.4, aqiLow: 401, aqiHigh: 500 },
];

/**
 * Converts a PM2.5 concentration (µg/m³) to an AQI value using EPA breakpoints.
 * Returns null if the value is out of range or non-finite.
 * @param {number} pm25
 * @returns {number|null}
 */
function pm25ToAqi(pm25) {
  if (!Number.isFinite(pm25) || pm25 < 0) return null;
  const bp = AQI_BREAKPOINTS.find((b) => pm25 >= b.pmLow && pm25 <= b.pmHigh);
  if (!bp) return pm25 > 500.4 ? 500 : null;
  return Math.round(
    ((bp.aqiHigh - bp.aqiLow) / (bp.pmHigh - bp.pmLow)) * (pm25 - bp.pmLow) + bp.aqiLow,
  );
}

// ---------------------------------------------------------------------------
// OpenAQ helpers
// ---------------------------------------------------------------------------

async function openaqFetch(path) {
  const url = `${OPENAQ_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = { Accept: "application/json" };
    if (OPENAQ_API_KEY) headers["X-API-Key"] = OPENAQ_API_KEY;
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`OpenAQ ${path} → HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the average PM2.5 (µg/m³) across all active monitoring stations near a city,
 * plus the derived AQI value.  Returns `null` if no PM2.5 data is available.
 *
 * Strategy:
 *   1. Query /locations by coordinates + 25km radius
 *   2. Collect all sensors with parameter name "pm25"
 *   3. Fetch the latest measurement for all sensors in parallel
 *   4. Average all readings and convert to AQI
 *
 * @param {number} lat  City latitude
 * @param {number} lng  City longitude
 * @returns {Promise<{ pm25Avg: number, aqiValue: number }|null>}
 */
async function fetchCityAirQuality(lat, lng) {
  let locData;
  try {
    locData = await openaqFetch(
      `/locations?coordinates=${lat},${lng}&radius=25000&limit=20`,
    );
  } catch (err) {
    throw new Error(`OpenAQ locations fetch failed at (${lat},${lng}): ${err.message}`);
  }

  // Only use stations that have reported data in the last 7 days
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const locations = (locData?.results ?? []).filter((r) => {
    const last = r.datetimeLast?.utc;
    return last && new Date(last).getTime() > cutoff;
  });
  if (locations.length === 0) return null;

  // Collect all PM2.5 sensor IDs across all locations
  const sensorIds = locations
    .flatMap((loc) => loc.sensors ?? [])
    .filter((s) => String(s.parameter?.name ?? "").toLowerCase() === "pm25" && s.id)
    .map((s) => s.id);

  if (sensorIds.length === 0) return null;

  // Fetch latest measurement for each sensor sequentially to avoid rate limits
  const readings = [];
  const measCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const id of sensorIds) {
    try {
      const measData = await openaqFetch(`/sensors/${id}/measurements?limit=1`);
      const result = measData?.results?.[0];
      const val = result?.value;
      const ts = result?.period?.datetimeTo?.utc ?? result?.period?.datetimeFrom?.utc;
      const isRecent = ts && new Date(ts).getTime() > measCutoff;
      const isValid = val != null && Number.isFinite(Number(val)) && Number(val) >= 0;
      readings.push(isValid && isRecent ? Number(val) : null);
    } catch {
      readings.push(null);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const pm25Readings = readings.filter((v) => v !== null);

  if (pm25Readings.length === 0) return null;

  const pm25Avg = pm25Readings.reduce((a, b) => a + b, 0) / pm25Readings.length;
  const aqiValue = pm25ToAqi(pm25Avg);
  if (aqiValue == null) return null;

  return { pm25Avg: Math.round(pm25Avg * 10) / 10, aqiValue };
}

module.exports = { fetchCityAirQuality, pm25ToAqi };
