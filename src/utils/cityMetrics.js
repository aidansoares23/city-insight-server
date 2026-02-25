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
//  *
//  * Canonical rent field: medianRent (monthly USD).
//  * We do NOT keep medianGrossRent as a separate stored field anymore.
//  */
// const OWNERS = {
//   // syncMetrics.js (Census / “objective truth”)
//   metricsSync: new Set(["population", "medianRent"]),

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
//       out[key] = patch[key];
//     }
//   }
//   // meta is not "owned" per se; allow it for all callers if present
//   if (Object.prototype.hasOwnProperty.call(patch, "meta")) out.meta = patch.meta;
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
//  * Read metrics (minimal public contract):
//  * - medianRent (monthly USD)
//  * - population
//  * - safetyScore (0–100)
//  * - crimeIndexPer100k
//  * - meta
//  */
// async function getCityMetrics(cityId) {
//   const snap = await db.collection("city_metrics").doc(cityId).get();
//   if (!snap.exists) {
//     return {
//       cityId,
//       medianRent: null,
//       population: null,
//       safetyScore: null,
//       crimeIndexPer100k: null,
//       meta: null,
//     };
//   }

//   const d = snap.data() || {};

//   return {
//     cityId,
//     medianRent: toNumOrNull(d.medianRent),
//     population: toNumOrNull(d.population),

//     // NOTE: if you ever decide 0 is a placeholder, map 0 -> null here.
//     safetyScore: clamp0to100(toNumOrNull(d.safetyScore)),

//     crimeIndexPer100k: toNumOrNull(d.crimeIndexPer100k),
//     meta: isPlainObject(d.meta) ? d.meta : null,
//   };
// }

// module.exports = { upsertCityMetrics, getCityMetrics };
// src/utils/cityMetrics.js
const { db, admin } = require("../config/firebase");
const { updatedTimestamp } = require("./timestamps");

const { toNumOrNull, clamp0to100 } = require("../lib/numbers");
const { isPlainObject } = require("../lib/objects");
const { buildNamespacedMetaUpdate } = require("../lib/meta");

/**
 * Field ownership / allowlist
 * Prevent scripts from accidentally clobbering other fields with null.
 *
 * Canonical rent field: medianRent (monthly USD).
 */
const OWNERS = {
  metricsSync: new Set(["population", "medianRent"]),
  safetySync: new Set(["safetyScore", "crimeIndexPer100k"]),
};

function pickOwnedFields(patch, allowedSet) {
  const out = {};
  for (const key of allowedSet) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      out[key] = patch[key];
    }
  }
  // NOTE:
  // meta is handled separately (namespaced under meta.<owner>),
  // but we still allow patch.meta to be passed through.
  if (Object.prototype.hasOwnProperty.call(patch, "meta"))
    out.meta = patch.meta;
  return out;
}

function clamp0to10(n) {
  if (n == null) return null;
  return Math.max(0, Math.min(10, n));
}

// Back-compat: if someone stored 0–100, convert it to 0–10
function normalizeSafetyTo10(x) {
  const n = toNumOrNull(x);
  if (n == null) return null;
  const maybe10 = n > 10 ? n / 10 : n; // assumes old scale if > 10
  return clamp0to10(Math.round(maybe10 * 10) / 10);
}

/**
 * Upsert city_metrics with safe partial update.
 *
 * Options:
 * - owner: "metricsSync" | "safetySync" | undefined
 *   If provided, only fields owned by that pipeline can be written.
 *
 * Meta behavior:
 * - If owner is set AND patch.meta is provided, we write it to meta.<owner>
 *   using update() so it won't clobber other meta namespaces.
 * - If owner is NOT set, we fall back to old behavior (writes meta as a whole).
 *   (We’ll migrate callers off that over time.)
 */
async function upsertCityMetrics(cityId, patch, options = {}) {
  const ref = db.collection("city_metrics").doc(cityId);
  const safePatch = isPlainObject(patch) ? patch : {};

  const owner = options?.owner ? String(options.owner) : null;
  const allowSet = owner && OWNERS[owner] ? OWNERS[owner] : null;

  const ownedOnly = allowSet ? pickOwnedFields(safePatch, allowSet) : safePatch;

  // Build docPatch using "field present" semantics:
  const docPatch = {
    cityId,

    ...(Object.prototype.hasOwnProperty.call(ownedOnly, "medianRent")
      ? { medianRent: toNumOrNull(ownedOnly.medianRent) }
      : {}),

    ...(Object.prototype.hasOwnProperty.call(ownedOnly, "population")
      ? { population: toNumOrNull(ownedOnly.population) }
      : {}),

    ...(Object.prototype.hasOwnProperty.call(ownedOnly, "safetyScore")
      ? { safetyScore: normalizeSafetyTo10(ownedOnly.safetyScore) }
      : {}),

    ...(Object.prototype.hasOwnProperty.call(ownedOnly, "crimeIndexPer100k")
      ? { crimeIndexPer100k: toNumOrNull(ownedOnly.crimeIndexPer100k) }
      : {}),

    ...updatedTimestamp(),
  };

  // 1) Always set core fields first (ensures doc exists).
  await ref.set(docPatch, { merge: true });

  // 2) Namespaced meta write (safe, won’t clobber).
  if (owner && Object.prototype.hasOwnProperty.call(ownedOnly, "meta")) {
    const metaUpdate = buildNamespacedMetaUpdate(owner, ownedOnly.meta);
    if (metaUpdate) {
      // update() understands dotted field paths; it won't overwrite the whole meta object
      await ref.update(metaUpdate);
    }
  } else if (
    !owner &&
    Object.prototype.hasOwnProperty.call(ownedOnly, "meta")
  ) {
    // Back-compat fallback (we'll phase this out)
    await ref.set({ meta: ownedOnly.meta }, { merge: true });
  }

  return docPatch;
}

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
    safetyScore: normalizeSafetyTo10(d.safetyScore),
    crimeIndexPer100k: toNumOrNull(d.crimeIndexPer100k),
    meta: isPlainObject(d.meta) ? d.meta : null,
  };
}

module.exports = { upsertCityMetrics, getCityMetrics };
