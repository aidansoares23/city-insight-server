// src/lib/slugs.js

/**
 * Convert Census "NAME" field into your slug format: "<city>-ca"
 * Example: "San Luis Obispo city, California" -> "san-luis-obispo-ca"
 */
function censusNameToSlug(name) {
  const cleaned = String(name).trim();
  const withoutSuffix = cleaned
    .replace(/\s+(city|town|village|CDP)\s*,\s*California\s*$/i, "")
    .replace(/\s*,\s*California\s*$/i, "");

  return withoutSuffix.toLowerCase().replace(/\s+/g, "-") + "-ca";
}

module.exports = { censusNameToSlug };
