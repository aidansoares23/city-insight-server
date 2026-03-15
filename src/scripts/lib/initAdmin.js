require("dotenv").config();

const admin = require("firebase-admin");
const path = require("path");

/**
 * Initializes the Firebase Admin SDK using the service account at `FIREBASE_SERVICE_ACCOUNT_PATH`.
 * Idempotent — returns the existing `admin` instance if already initialized.
 * @returns {import("firebase-admin")} the initialized admin instance
 */
function initAdmin() {
  if (admin.apps.length) return admin;

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!serviceAccountPath) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_PATH in .env");
  }

  const resolved = path.isAbsolute(serviceAccountPath)
    ? serviceAccountPath
    : path.join(process.cwd(), serviceAccountPath);

  const serviceAccount = require(resolved);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return admin;
}

module.exports = { initAdmin };
