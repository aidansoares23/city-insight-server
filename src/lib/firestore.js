const { admin } = require("../config/firebase");

/** Converts a Firestore Timestamp (or `{ _seconds }` plain object) to an ISO string; returns `null` for falsy input. */
function tsToIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate().toISOString();
  if (ts._seconds != null) return new Date(ts._seconds * 1000).toISOString();
  return null;
}

/** Spreads an object while converting `createdAt` and `updatedAt` Firestore Timestamps to ISO strings. */
function withIsoTimestamps(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const { createdAt, updatedAt, ...rest } = obj;
  return {
    ...rest,
    createdAt: tsToIso(createdAt),
    updatedAt: tsToIso(updatedAt),
  };
}

/**
 * Builds a pagination cursor `{ id, createdAt }` from a Firestore document.
 * `createdAt` is an ISO string (or `null`); pass this as `nextCursor` in API responses.
 */
function buildNextCursorFromDoc(doc) {
  const data = doc.data() || {};
  return { id: doc.id, createdAt: tsToIso(data.createdAt) };
}

/**
 * Parses a Firestore pagination cursor from Express query params.
 * Prefers `cursorId` + `cursorCreatedAt`; falls back to legacy `after=<docId>`.
 * Returns `null` if no valid cursor is present.
 */
function parseCursorFromQuery(query) {
  const cursorId = query.cursorId ? String(query.cursorId).trim() : null;
  const cursorCreatedAt = query.cursorCreatedAt
    ? String(query.cursorCreatedAt).trim()
    : null;

  if (cursorId && cursorCreatedAt) {
    const dt = new Date(cursorCreatedAt);
    if (!Number.isNaN(dt.valueOf())) {
      return {
        id: cursorId,
        createdAt: admin.firestore.Timestamp.fromDate(dt),
      };
    }
  }

  // Back-compat: after=<docId>
  const after = query.after ? String(query.after).trim() : null;
  if (after) return { afterIdOnly: after };

  return null;
}

module.exports = {
  tsToIso,
  withIsoTimestamps,
  buildNextCursorFromDoc,
  parseCursorFromQuery,
};
