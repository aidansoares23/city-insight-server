// src/lib/meta.js
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
  const o = owner ? String(owner).trim() : "";
  if (!o) return null;

  // Allow explicit clear (set to null)
  if (meta === null) return { [`meta.${o}`]: null };

  // Ignore undefined or non-object
  if (meta === undefined) return null;
  if (!isPlainObject(meta)) return null;

  return { [`meta.${o}`]: meta };
}

module.exports = { buildNamespacedMetaUpdate };
