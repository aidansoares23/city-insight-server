/**
 * Convert Census "NAME" field into your slug format: "<city>-ca"
 * Example: "San Luis Obispo city, California" -> "san-luis-obispo-ca"
 * @deprecated Use `censusNameToStateSlug` for multi-state support.
 */
function censusNameToSlug(name) {
  const cleaned = String(name).trim();
  const withoutSuffix = cleaned
    .replace(/\s+(city|town|village|CDP)\s*,\s*California\s*$/i, "")
    .replace(/\s*,\s*California\s*$/i, "");

  return withoutSuffix.toLowerCase().replace(/\s+/g, "-") + "-ca";
}

// Census NAME values that don't match the city's common name.
// Key: normalized Census place name (lowercase, no state suffix), Value: slug city name segment
const CENSUS_NAME_OVERRIDES = {
  "san buenaventura (ventura)": "ventura",
};

/**
 * Converts a Census "NAME" field and 2-letter state abbreviation into a slug.
 * Strips the place type suffix (city, town, village, CDP) and state name.
 * Example: ("Portland city, Oregon", "OR") -> "portland-or"
 * @param {string} name - Census NAME field value
 * @param {string} stateAbbr - 2-letter state abbreviation, e.g. "OR"
 * @returns {string}
 */
function censusNameToStateSlug(name, stateAbbr) {
  const abbr = String(stateAbbr).trim().toLowerCase();
  const withoutSuffix = String(name)
    .trim()
    .replace(/\s+(city|town|village|CDP)\s*,\s*[^,]+$/i, "")
    .replace(/\s*,\s*[^,]+$/, ""); // strip ", StateName"

  const normalized = withoutSuffix.toLowerCase();
  const cityName = CENSUS_NAME_OVERRIDES[normalized] ?? normalized.replace(/\s+/g, "-");
  return cityName + "-" + abbr;
}

module.exports = { censusNameToSlug, censusNameToStateSlug };
