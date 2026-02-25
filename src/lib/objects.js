// src/lib/objects.js

function isPlainObject(x) {
  return x != null && typeof x === "object" && !Array.isArray(x);
}

module.exports = { isPlainObject };
