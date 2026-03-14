const { isPlainObject } = require("./objects");

/**
 * Goal: avoid meta collisions by namespacing meta per pipeline:
 * meta: {
 *   metricsSync: {...},
 *   safetySync: {...},
 * }
 *
 * This returns an object suitable for Firestore update() with nested field paths.
 */
function buildNamespacedMetaUpdate(owner, meta) {
  const namespace = owner ? String(owner).trim() : "";
  if (!namespace) return null;

  if (meta === null) return { [`meta.${namespace}`]: null };
  if (meta === undefined) return null;
  if (!isPlainObject(meta)) return null;

  return { [`meta.${namespace}`]: meta };
}

module.exports = { buildNamespacedMetaUpdate };
