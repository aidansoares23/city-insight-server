// src/utils/timestamps.js
const { admin } = require("../config/firebase");

function serverTimestamps() {
  const t = admin.firestore.FieldValue.serverTimestamp();
  return {
    createdAt: t,
    updatedAt: t,
  };
}

function updatedTimestamp() {
  return {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

module.exports = {
  serverTimestamps,
  updatedTimestamp,
};
