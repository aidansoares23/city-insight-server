const { FBI_API_KEY } = require("../config/env");

const FBI_BASE = "https://api.usa.gov/crime/fbi/cde";

/**
 * Fetches and flattens all law enforcement agencies for a given state.
 * The FBI API returns { [county]: [agency, ...] }; this flattens it to a plain array.
 * Each agency includes: { ori, agency_name, agency_type_name, state_abbr, is_nibrs, ... }.
 * @param {string} stateAbbr - 2-letter state abbreviation, e.g. "OR"
 * @returns {Promise<Array<{ ori: string, agency_name: string, agency_type_name: string }>>}
 */
async function fetchAgenciesByState(stateAbbr) {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is unavailable. Use Node.js 18+.");
  }
  const url = `${FBI_BASE}/agency/byStateAbbr/${encodeURIComponent(stateAbbr)}?API_KEY=${FBI_API_KEY}`;
  const res = await globalThis.fetch(url);
  if (!res.ok) {
    throw new Error(`FBI agencies API failed (${stateAbbr}): HTTP ${res.status}`);
  }
  const data = await res.json();

  // Response shape: { "COUNTY_NAME": [agency, ...], ... } — flatten to a single array.
  return Object.values(data).flat();
}

/**
 * Fetches monthly offense rates per 100k for a specific agency ORI and offense type.
 * The FBI API returns rates keyed by month ("MM-YYYY") under the agency's name.
 *
 * Response shape:
 *   { offenses: { rates: { "{Agency Name} Offenses": { "01-2020": 45.2, ... }, ... } } }
 *
 * Returns the agency's own monthly rate map (not state/national averages).
 * Returns null if the agency key can't be found in the response.
 *
 * @param {string} ori - FBI ORI code, e.g. "OR0260200"
 * @param {"violent-crime"|"property-crime"} offenseType
 * @param {string} agencyName - full agency name used to locate the right key in the response
 * @param {number} [fromYear=2020]
 * @param {number} [toYear=2023]
 * @returns {Promise<Record<string, number>|null>} map of "MM-YYYY" -> rate per 100k
 */
async function fetchOffenseRates(ori, offenseType, agencyName, fromYear = 2020, toYear = 2023) {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is unavailable. Use Node.js 18+.");
  }
  const from = `01-${fromYear}`;
  const to   = `12-${toYear}`;
  const url  = `${FBI_BASE}/summarized/agency/${encodeURIComponent(ori)}/${encodeURIComponent(offenseType)}?from=${from}&to=${to}&API_KEY=${FBI_API_KEY}`;

  const res = await globalThis.fetch(url);
  if (!res.ok) {
    throw new Error(`FBI offenses API failed (${ori} / ${offenseType}): HTTP ${res.status}`);
  }
  const body = await res.json();

  const rates = body?.offenses?.rates;
  if (!rates || typeof rates !== "object") return null;

  // The agency's key is always "{agency_name} Offenses".
  const agencyKey = `${agencyName} Offenses`;
  return rates[agencyKey] ?? null;
}

module.exports = { fetchAgenciesByState, fetchOffenseRates };
