const admin = require("firebase-admin");
const path = require("path");

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  // Easiest local dev: point to your service account JSON file in .env
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
}

initFirebaseAdmin();

const db = admin.firestore();

module.exports = { admin, db };
