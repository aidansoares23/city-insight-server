const { toNumOrNull } = require("../lib/numbers");

const ACS_YEAR = "2023";
const ACS_BASE = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5`;

// B01003_001E = total population, B25064_001E = median gross rent
const ACS_VARS = ["B01003_001E", "B25064_001E", "NAME"];

/** Maps 2-letter state abbreviation to Census FIPS code. */
const STATE_FIPS = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06",
  CO: "08", CT: "09", DE: "10", FL: "12", GA: "13",
  HI: "15", ID: "16", IL: "17", IN: "18", IA: "19",
  KS: "20", KY: "21", LA: "22", ME: "23", MD: "24",
  MA: "25", MI: "26", MN: "27", MS: "28", MO: "29",
  MT: "30", NE: "31", NV: "32", NH: "33", NJ: "34",
  NM: "35", NY: "36", NC: "37", ND: "38", OH: "39",
  OK: "40", OR: "41", PA: "42", RI: "44", SC: "45",
  SD: "46", TN: "47", TX: "48", UT: "49", VT: "50",
  VA: "51", WA: "53", WV: "54", WI: "55", WY: "56",
};

/**
 * Fetches ACS 5-year population and median rent for all incorporated places in a state.
 * Requires Node.js 18+ for the global `fetch` API.
 * @param {string} stateAbbr - 2-letter abbreviation, e.g. "OR"
 * @returns {Promise<Array<{ name: string, population: number|null, medianRent: number|null }>>}
 */
async function fetchAcsPlacesByState(stateAbbr) {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is unavailable. Use Node.js 18+.");
  }

  const fips = STATE_FIPS[stateAbbr.toUpperCase()];
  if (!fips) throw new Error(`Unknown state abbreviation: ${stateAbbr}`);

  const url = `${ACS_BASE}?get=${ACS_VARS.join(",")}&for=place:*&in=state:${fips}`;

  const res = await globalThis.fetch(url);
  if (!res.ok) throw new Error(`ACS API failed (${stateAbbr}): HTTP ${res.status}`);

  const rows = await res.json();
  const header = rows[0];
  const idxPop  = header.indexOf("B01003_001E");
  const idxRent = header.indexOf("B25064_001E");
  const idxName = header.indexOf("NAME");

  if (idxPop < 0 || idxRent < 0 || idxName < 0) {
    throw new Error(`Unexpected ACS response shape for state ${stateAbbr}`);
  }

  return rows.slice(1).map((r) => ({
    name:       r[idxName],
    population: toNumOrNull(r[idxPop]),
    medianRent: toNumOrNull(r[idxRent]),
  }));
}

module.exports = { fetchAcsPlacesByState, STATE_FIPS, ACS_YEAR };
