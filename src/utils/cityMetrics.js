const { db } = require("../config/firebase");
const { updatedTimestamp } = require("./timestamps");
const {
  toNumOrNull,
  medianRentToAffordability10,
  normalizeSafetyTo10,
} = require("../lib/numbers");
const { isPlainObject } = require("../lib/objects");
const { buildNamespacedMetaUpdate } = require("../lib/meta");

// Each pipeline owns a specific set of fields — prevents cross-pipeline overwrites.
const OWNERS = {
  metricsSync: new Set(["population", "medianRent"]),
  safetySync:  new Set(["safetyScore", "crimeIndexPer100k"]),
};

const METRIC_FIELDS = [
  { key: "medianRent",         normalize: toNumOrNull },
  { key: "population",         normalize: toNumOrNull },
  { key: "safetyScore",        normalize: normalizeSafetyTo10 },
  { key: "crimeIndexPer100k",  normalize: toNumOrNull },
];

function pickOwnedFields(patch, allowedSet) {
  const ownedFields = {};
  for (const key of allowedSet) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) ownedFields[key] = patch[key];
  }
  // meta is passed through and namespaced separately during the write
  if (Object.prototype.hasOwnProperty.call(patch, "meta")) ownedFields.meta = patch.meta;
  return ownedFields;
}


async function upsertCityMetrics(cityId, patch, options = {}) {
  const ref = db.collection("city_metrics").doc(cityId);
  const safePatch = isPlainObject(patch) ? patch : {};

  const owner = options?.owner ? String(options.owner) : null;
  const allowSet = owner && OWNERS[owner] ? OWNERS[owner] : null;
  const ownedOnly = allowSet ? pickOwnedFields(safePatch, allowSet) : safePatch;

  let prevData = {};
  if (owner) {
    const snap = await ref.get();
    prevData = snap.exists ? snap.data() : {};
  }

  const docPatch = { cityId, ...updatedTimestamp() };
  const prevValues = {};
  const newValues = {};

  for (const { key, normalize } of METRIC_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(ownedOnly, key)) continue;
    const newVal = normalize(ownedOnly[key]);
    const prevVal = owner ? normalize(prevData[key]) : null;
    if (owner && newVal === null && prevVal !== null) {
      console.warn(`[metrics] null-guard: skipping ${key} for ${cityId} (new=null, keeping existing=${prevVal})`);
      continue;
    }
    docPatch[key] = newVal;
    if (owner) {
      prevValues[key] = prevVal;
      newValues[key] = newVal;
    }
  }

  await ref.set(docPatch, { merge: true });

  // Namespaced meta write — dotted paths leave other pipeline namespaces untouched.
  if (owner && Object.prototype.hasOwnProperty.call(ownedOnly, "meta")) {
    const metaUpdate = buildNamespacedMetaUpdate(owner, ownedOnly.meta);
    if (metaUpdate) await ref.update(metaUpdate);
  } else if (!owner && Object.prototype.hasOwnProperty.call(ownedOnly, "meta")) {
    await ref.set({ meta: ownedOnly.meta }, { merge: true });
  }

  if (owner && Object.keys(newValues).length > 0) {
    const changed = Object.keys(newValues).some((key) => newValues[key] !== prevValues[key]);
    await ref.collection("snapshots").add({
      pipeline: owner,
      syncedAt: new Date().toISOString(),
      prevValues,
      newValues,
      changed,
      ...(isPlainObject(ownedOnly.meta) ? { meta: ownedOnly.meta } : {}),
    });
  }

  return docPatch;
}

async function getCityMetrics(cityId) {
  const snap = await db.collection("city_metrics").doc(cityId).get();
  if (!snap.exists) {
    return {
      cityId,
      medianRent: null,
      costScore: null,
      population: null,
      safetyScore: null,
      crimeIndexPer100k: null,
      meta: null,
    };
  }

  const metricsData = snap.data() || {};
  const medianRent = toNumOrNull(metricsData.medianRent);
  return {
    cityId,
    medianRent,
    costScore:        medianRentToAffordability10(medianRent),
    population:       toNumOrNull(metricsData.population),
    safetyScore:      normalizeSafetyTo10(metricsData.safetyScore),
    crimeIndexPer100k: toNumOrNull(metricsData.crimeIndexPer100k),
    meta:             isPlainObject(metricsData.meta) ? metricsData.meta : null,
  };
}

module.exports = { upsertCityMetrics, getCityMetrics };
