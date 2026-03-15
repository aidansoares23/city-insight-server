const { admin } = require("../config/firebase");

/** Returns `{ createdAt, updatedAt }` both set to Firestore server timestamp — use on document creation. */
function serverTimestamps() {
  const t = admin.firestore.FieldValue.serverTimestamp();
  return {
    createdAt: t,
    updatedAt: t,
  };
}

/** Returns `{ updatedAt }` set to Firestore server timestamp — use on document updates. */
function updatedTimestamp() {
  return {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

module.exports = {
  serverTimestamps,
  updatedTimestamp,
};
