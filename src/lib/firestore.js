const { admin } = require("../config/firebase");

function tsToIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate().toISOString();
  if (ts._seconds != null) return new Date(ts._seconds * 1000).toISOString();
  return null;
}

function withIsoTimestamps(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const { createdAt, updatedAt, ...rest } = obj;
  return {
    ...rest,
    createdAt: tsToIso(createdAt),
    updatedAt: tsToIso(updatedAt),
  };
}

// Cursor shape: { id: string, createdAt: string|null }
function buildNextCursorFromDoc(doc) {
  const data = doc.data() || {};
  return { id: doc.id, createdAt: tsToIso(data.createdAt) };
}

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
