const { db } = require("../config/firebase");
const { updatedTimestamp } = require("./timestamps");
const { toNumOrNull, normalizeSafetyTo10 } = require("../lib/numbers");
const { isPlainObject } = require("../lib/objects");
const { buildNamespacedMetaUpdate } = require("../lib/meta");

// Each pipeline owns a specific set of fields — prevents cross-pipeline overwrites.
const OWNERS = {
  metricsSync: new Set(["population", "medianRent"]),
  safetySync:  new Set(["safetyScore", "crimeIndexPer100k"]),
};

function pickOwnedFields(patch, allowedSet) {
  const out = {};
  for (const key of allowedSet) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key];
  }
  // meta is passed through and namespaced separately during the write
  if (Object.prototype.hasOwnProperty.call(patch, "meta")) out.meta = patch.meta;
  return out;
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

  function tryAddField(key, newVal, prevVal) {
    if (!Object.prototype.hasOwnProperty.call(ownedOnly, key)) return;
    if (owner && newVal === null && prevVal !== null) {
      console.warn(`[metrics] null-guard: skipping ${key} for ${cityId} (new=null, keeping existing=${prevVal})`);
      return;
    }
    docPatch[key] = newVal;
    if (owner) {
      prevValues[key] = prevVal;
      newValues[key] = newVal;
    }
  }

  tryAddField("medianRent",       toNumOrNull(ownedOnly.medianRent),           toNumOrNull(prevData.medianRent));
  tryAddField("population",       toNumOrNull(ownedOnly.population),           toNumOrNull(prevData.population));
  tryAddField("safetyScore",      normalizeSafetyTo10(ownedOnly.safetyScore),  normalizeSafetyTo10(prevData.safetyScore));
  tryAddField("crimeIndexPer100k", toNumOrNull(ownedOnly.crimeIndexPer100k),   toNumOrNull(prevData.crimeIndexPer100k));

  await ref.set(docPatch, { merge: true });

  // Namespaced meta write — dotted paths leave other pipeline namespaces untouched.
  if (owner && Object.prototype.hasOwnProperty.call(ownedOnly, "meta")) {
    const metaUpdate = buildNamespacedMetaUpdate(owner, ownedOnly.meta);
    if (metaUpdate) await ref.update(metaUpdate);
  } else if (!owner && Object.prototype.hasOwnProperty.call(ownedOnly, "meta")) {
    await ref.set({ meta: ownedOnly.meta }, { merge: true });
  }

  if (owner && Object.keys(newValues).length > 0) {
    const changed = Object.keys(newValues).some((k) => newValues[k] !== prevValues[k]);
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
    return { cityId, medianRent: null, population: null, safetyScore: null, crimeIndexPer100k: null, meta: null };
  }

  const d = snap.data() || {};
  return {
    cityId,
    medianRent:       toNumOrNull(d.medianRent),
    population:       toNumOrNull(d.population),
    safetyScore:      normalizeSafetyTo10(d.safetyScore),
    crimeIndexPer100k: toNumOrNull(d.crimeIndexPer100k),
    meta:             isPlainObject(d.meta) ? d.meta : null,
  };
}

module.exports = { upsertCityMetrics, getCityMetrics };
