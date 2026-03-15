const { db, admin } = require("../../config/firebase");
const { toOptionalNumOrNull } = require("../../lib/numbers");

/** Splits a comma-separated highlights string into a trimmed array; returns `[]` if falsy. */
function parseHighlights(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Trims and lowercases a raw slug string. */
function normalizeSlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

/** Trims a raw string and returns it, or `null` if blank. */
function normalizeStringOrNull(raw) {
  const s = String(raw ?? "").trim();
  return s ? s : null;
}

/**
 * Validates required city fields; returns an array of error strings (empty if valid).
 * @param {{ slug: string, name: string, state: string }} fields
 * @returns {string[]}
 */
function validateRequired({ slug, name, state }) {
  const errors = [];
  if (!slug) errors.push("slug is required");
  if (!name) errors.push("name is required");
  if (!state) errors.push("state is required");
  if (state && state.length !== 2) errors.push("state must be 2 letters (e.g. CA)");
  return errors;
}

/**
 * Creates or non-destructively updates a city document in Firestore.
 * Normalizes all fields before writing; sets `createdAt` only on first creation.
 * @param {{ slug: string, name: string, state: string, lat?: string, lng?: string, tagline?: string, description?: string, highlights?: string, dryRun?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, cityId: string, created: boolean|null, dryRun: boolean }>}
 */
async function taskCityUpsert({
  slug,
  name,
  state,
  lat,
  lng,
  tagline,
  description,
  highlights,
  dryRun = false,
} = {}) {
  const cityId = normalizeSlug(slug);
  const cityName = normalizeStringOrNull(name);
  const cityState = normalizeStringOrNull(state)?.toUpperCase() ?? null;
  const cityTagline = normalizeStringOrNull(tagline);
  const cityDescription = normalizeStringOrNull(description);
  const cityHighlights = parseHighlights(highlights);
  const cityLat = toOptionalNumOrNull(lat);
  const cityLng = toOptionalNumOrNull(lng);

  const errors = validateRequired({
    slug: cityId,
    name: cityName,
    state: cityState,
  });
  if (errors.length) {
    throw new Error(`city-upsert validation failed: ${errors.join("; ")}`);
  }

  const payload = {
    slug: cityId,
    name: cityName,
    state: cityState,
    lat: cityLat,
    lng: cityLng,
    tagline: cityTagline,
    description: cityDescription,
    highlights: cityHighlights,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (dryRun) {
    console.log("[dry-run][city-upsert] would write cities/" + cityId, payload);
    return { ok: true, cityId, created: null, dryRun: true };
  }

  const ref = db.collection("cities").doc(cityId);
  const existing = await ref.get();
  if (!existing.exists) {
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  await ref.set(payload, { merge: true });

  console.log(
    `[city-upsert] ${existing.exists ? "updated" : "created"} cities/${cityId}`,
  );
  return { ok: true, cityId, created: !existing.exists, dryRun: false };
}

module.exports = { taskCityUpsert };
