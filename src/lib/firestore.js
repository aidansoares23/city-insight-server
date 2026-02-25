// src/lib/firestore.js
const { admin } = require("../config/firebase");

function tsToIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate().toISOString();
  if (ts._seconds != null) return new Date(ts._seconds * 1000).toISOString();
  return null;
}

function withIsoTimestamps(obj) {
  if (!obj || typeof obj !== "object") return obj;
  return {
    ...obj,
    createdAtIso: tsToIso(obj.createdAt),
    updatedAtIso: tsToIso(obj.updatedAt),
  };
}

// Cursor shape: { id: string, createdAtIso: string|null }
function buildNextCursorFromDoc(doc) {
  const data = doc.data() || {};
  return { id: doc.id, createdAtIso: tsToIso(data.createdAt) };
}

function parseCursorFromQuery(query) {
  const cursorId = query.cursorId ? String(query.cursorId).trim() : null;
  const cursorCreatedAtIso = query.cursorCreatedAtIso
    ? String(query.cursorCreatedAtIso).trim()
    : null;

  if (cursorId && cursorCreatedAtIso) {
    const dt = new Date(cursorCreatedAtIso);
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
