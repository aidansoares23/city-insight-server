/** Returns `true` if `value` is a non-null, non-array object. */
function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

module.exports = { isPlainObject };
