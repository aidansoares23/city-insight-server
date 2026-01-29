// // src/utils/cityMetrics.js
// const { db } = require("../config/firebase");
// const { updatedTimestamp } = require("./timestamps");

// function toNumOrNull(x) {
//   const n = Number(x);
//   return Number.isFinite(n) ? n : null;
// }

// function clamp0to100(n) {
//   if (n == null) return null;
//   return Math.max(0, Math.min(100, Math.round(n)));
// }

// function isPlainObject(x) {
//   return x != null && typeof x === "object" && !Array.isArray(x);
// }

// /**
//  * Merge-safe meta patch helper.
//  * Allows callers to set meta.source, meta.syncedAt, etc.
//  */
// function buildMetaPatch(meta) {
//   if (meta === undefined) return {};
//   if (meta === null) return { meta: null }; // allow clearing meta intentionally
//   if (!isPlainObject(meta)) return {};
//   return { meta };
// }

// /**
//  * Field ownership / allowlist
//  * Prevent scripts from accidentally clobbering other fields with null.
//  */
// const OWNERS = {
//   // syncMetrics.js (Census / “objective truth”)
//   metricsSync: new Set(["population", "medianRent", "medianGrossRent"]),

//   // syncSafetyFromCsv.js (crime csv pipeline)
//   safetySync: new Set(["safetyScore", "crimeIndexPer100k"]),
// };

// /**
//  * Return a new object containing only keys present in allowed set.
//  * Special rule: if a key is present with value `undefined`, we treat it as "not provided".
//  * If present with `null`, we treat it as "explicitly clear it" (allowed only if owned).
//  */
// function pickOwnedFields(patch, allowedSet) {
//   const out = {};
//   for (const key of allowedSet) {
//     if (Object.prototype.hasOwnProperty.call(patch, key)) {
//       // explicitly provided (could be null)
//       out[key] = patch[key];
//     }
//   }
//   return out;
// }

// /**
//  * Upsert city_metrics with safe partial update.
//  *
//  * Options:
//  * - owner: "metricsSync" | "safetySync" | undefined
//  *   If provided, only fields owned by that pipeline can be written.
//  *   This prevents syncMetrics from ever nulling safetyScore, etc.
//  */
// async function upsertCityMetrics(cityId, patch, options = {}) {
//   const ref = db.collection("city_metrics").doc(cityId);
//   const safePatch = isPlainObject(patch) ? patch : {};

//   const owner = options?.owner ? String(options.owner) : null;
//   const allowSet = owner && OWNERS[owner] ? OWNERS[owner] : null;

//   // If owner is set, strip fields not owned by that pipeline.
//   const ownedOnly = allowSet ? pickOwnedFields(safePatch, allowSet) : safePatch;

//   // Build docPatch using "field present" semantics:
//   // - if field not present => do nothing (won't overwrite)
//   // - if field present as null => overwrite to null (explicit clear)
//   const docPatch = {
//     cityId,

//     ...(Object.prototype.hasOwnProperty.call(ownedOnly, "medianRent")
//       ? { medianRent: toNumOrNull(ownedOnly.medianRent) }
//       : {}),

//     ...(Object.prototype.hasOwnProperty.call(ownedOnly, "medianGrossRent")
//       ? { medianGrossRent: toNumOrNull(ownedOnly.medianGrossRent) }
//       : {}),

//     ...(Object.prototype.hasOwnProperty.call(ownedOnly, "population")
//       ? { population: toNumOrNull(ownedOnly.population) }
//       : {}),

//     ...(Object.prototype.hasOwnProperty.call(ownedOnly, "safetyScore")
//       ? { safetyScore: clamp0to100(toNumOrNull(ownedOnly.safetyScore)) }
//       : {}),

//     ...(Object.prototype.hasOwnProperty.call(ownedOnly, "crimeIndexPer100k")
//       ? { crimeIndexPer100k: toNumOrNull(ownedOnly.crimeIndexPer100k) }
//       : {}),

//     ...buildMetaPatch(ownedOnly.meta),

//     ...updatedTimestamp(),
//   };

//   await ref.set(docPatch, { merge: true });
//   return docPatch;
// }

// /**
//  * Read metrics with back-compat:
//  * - medianRent (preferred) OR medianGrossRent (Census ACS B25064)
//  */
// async function getCityMetrics(cityId) {
//   const snap = await db.collection("city_metrics").doc(cityId).get();
//   if (!snap.exists) {
//     return {
//       cityId,
//       medianRent: null,
//       medianGrossRent: null,
//       population: null,
//       safetyScore: null,
//       crimeIndexPer100k: null,
//       meta: null,
//     };
//   }

//   const d = snap.data() || {};

//   return {
//     cityId,

//     // If you want to standardize on one field client-side, prefer medianRent and fallback.
//     medianRent: toNumOrNull(d.medianRent ?? d.medianGrossRent),
//     medianGrossRent: toNumOrNull(d.medianGrossRent),

//     population: toNumOrNull(d.population),

//     // NOTE: if you ever decide 0 is a placeholder, map 0 -> null here.
//     safetyScore: clamp0to100(toNumOrNull(d.safetyScore)),

//     crimeIndexPer100k: toNumOrNull(d.crimeIndexPer100k),
//     meta: isPlainObject(d.meta) ? d.meta : null,
//   };
// }

// module.exports = { upsertCityMetrics, getCityMetrics };


// src/utils/cityMetrics.js
const { db } = require("../config/firebase");
const { updatedTimestamp } = require("./timestamps");

function toNumOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function clamp0to100(n) {
  if (n == null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function isPlainObject(x) {
  return x != null && typeof x === "object" && !Array.isArray(x);
}

/**
 * Merge-safe meta patch helper.
 * Allows callers to set meta.source, meta.syncedAt, etc.
 */
function buildMetaPatch(meta) {
  if (meta === undefined) return {};
  if (meta === null) return { meta: null }; // allow clearing meta intentionally
  if (!isPlainObject(meta)) return {};
  return { meta };
}

/**
 * Field ownership / allowlist
 * Prevent scripts from accidentally clobbering other fields with null.
 *
 * Canonical rent field: medianRent (monthly USD).
 * We do NOT keep medianGrossRent as a separate stored field anymore.
 */
const OWNERS = {
  // syncMetrics.js (Census / “objective truth”)
  metricsSync: new Set(["population", "medianRent"]),

  // syncSafetyFromCsv.js (crime csv pipeline)
  safetySync: new Set(["safetyScore", "crimeIndexPer100k"]),
};

/**
 * Return a new object containing only keys present in allowed set.
 * Special rule: if a key is present with value `undefined`, we treat it as "not provided".
 * If present with `null`, we treat it as "explicitly clear it" (allowed only if owned).
 */
function pickOwnedFields(patch, allowedSet) {
  const out = {};
  for (const key of allowedSet) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      out[key] = patch[key];
    }
  }
  // meta is not "owned" per se; allow it for all callers if present
  if (Object.prototype.hasOwnProperty.call(patch, "meta")) out.meta = patch.meta;
  return out;
}

/**
 * Upsert city_metrics with safe partial update.
 *
 * Options:
 * - owner: "metricsSync" | "safetySync" | undefined
 *   If provided, only fields owned by that pipeline can be written.
 *   This prevents syncMetrics from ever nulling safetyScore, etc.
 */
async function upsertCityMetrics(cityId, patch, options = {}) {
  const ref = db.collection("city_metrics").doc(cityId);
  const safePatch = isPlainObject(patch) ? patch : {};

  const owner = options?.owner ? String(options.owner) : null;
  const allowSet = owner && OWNERS[owner] ? OWNERS[owner] : null;

  // If owner is set, strip fields not owned by that pipeline.
  const ownedOnly = allowSet ? pickOwnedFields(safePatch, allowSet) : safePatch;

  // Build docPatch using "field present" semantics:
  // - if field not present => do nothing (won't overwrite)
  // - if field present as null => overwrite to null (explicit clear)
  const docPatch = {
    cityId,

    ...(Object.prototype.hasOwnProperty.call(ownedOnly, "medianRent")
      ? { medianRent: toNumOrNull(ownedOnly.medianRent) }
      : {}),

    ...(Object.prototype.hasOwnProperty.call(ownedOnly, "population")
      ? { population: toNumOrNull(ownedOnly.population) }
      : {}),

    ...(Object.prototype.hasOwnProperty.call(ownedOnly, "safetyScore")
      ? { safetyScore: clamp0to100(toNumOrNull(ownedOnly.safetyScore)) }
      : {}),

    ...(Object.prototype.hasOwnProperty.call(ownedOnly, "crimeIndexPer100k")
      ? { crimeIndexPer100k: toNumOrNull(ownedOnly.crimeIndexPer100k) }
      : {}),

    ...buildMetaPatch(ownedOnly.meta),

    ...updatedTimestamp(),
  };

  await ref.set(docPatch, { merge: true });
  return docPatch;
}

/**
 * Read metrics (minimal public contract):
 * - medianRent (monthly USD)
 * - population
 * - safetyScore (0–100)
 * - crimeIndexPer100k
 * - meta
 */
async function getCityMetrics(cityId) {
  const snap = await db.collection("city_metrics").doc(cityId).get();
  if (!snap.exists) {
    return {
      cityId,
      medianRent: null,
      population: null,
      safetyScore: null,
      crimeIndexPer100k: null,
      meta: null,
    };
  }

  const d = snap.data() || {};

  return {
    cityId,
    medianRent: toNumOrNull(d.medianRent),
    population: toNumOrNull(d.population),

    // NOTE: if you ever decide 0 is a placeholder, map 0 -> null here.
    safetyScore: clamp0to100(toNumOrNull(d.safetyScore)),

    crimeIndexPer100k: toNumOrNull(d.crimeIndexPer100k),
    meta: isPlainObject(d.meta) ? d.meta : null,
  };
}

module.exports = { upsertCityMetrics, getCityMetrics };
