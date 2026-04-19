const admin = require("firebase-admin");
const path = require("path");

/**
 * Initializes Firebase Admin SDK once (idempotent).
 * Reads `FIREBASE_SERVICE_ACCOUNT_PATH` from env; resolves relative paths against `cwd()`.
 * When `FIRESTORE_EMULATOR_HOST` is set the Admin SDK automatically routes all
 * Firestore traffic to the local emulator — no real quota is consumed.
 * Throws if the env var is missing.
 */
function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

  if (!serviceAccountPath) {
    throw new Error(
      "Missing FIREBASE_SERVICE_ACCOUNT_PATH in .env (absolute path to your serviceAccountKey.json)"
    );
  }

  const absolutePath = path.isAbsolute(serviceAccountPath)
    ? serviceAccountPath
    : path.join(process.cwd(), serviceAccountPath);

  admin.initializeApp({
    credential: admin.credential.cert(require(absolutePath)),
  });

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.log(
      `[firebase] Firestore → emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`
    );
  }
}

initFirebaseAdmin();

const db = admin.firestore();

module.exports = { admin, db };
