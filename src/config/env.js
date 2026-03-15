/** Converts a string env var to a boolean; returns `true` only when the trimmed lowercase value equals `"true"`. */
function parseBool(val) {
  return String(val || "").trim().toLowerCase() === "true";
}

const NODE_ENV = process.env.NODE_ENV || "development";
const DEV_AUTH_BYPASS = parseBool(process.env.DEV_AUTH_BYPASS);

const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
if (!GOOGLE_CLIENT_ID) {
  console.warn("GOOGLE_CLIENT_ID is not set. Google auth will fail");
}

const REVIEW_ID_SALT = String(process.env.REVIEW_ID_SALT || "").trim();
if (!REVIEW_ID_SALT) {
  if (NODE_ENV === "production") {
    throw new Error("REVIEW_ID_SALT is required in production. Set this env var before starting.");
  }
  console.warn("REVIEW_ID_SALT is not set. Review ID generation will fail at runtime.");
}

const SESSION_JWT_SECRET = String(process.env.SESSION_JWT_SECRET || "").trim();
if (!SESSION_JWT_SECRET) {
  if (NODE_ENV === "production") {
    throw new Error("SESSION_JWT_SECRET is required in production. Set this env var before starting.");
  }
  console.warn("SESSION_JWT_SECRET is not set. Authentication will fail at runtime.");
}

// Fail closed: never allow bypass outside dev
if (NODE_ENV === "production" && DEV_AUTH_BYPASS) {
  throw new Error(
    "SECURITY: DEV_AUTH_BYPASS=true is not allowed in production. Set DEV_AUTH_BYPASS=false."
  );
}

module.exports = {
  NODE_ENV,
  DEV_AUTH_BYPASS,
  GOOGLE_CLIENT_ID,
  SESSION_JWT_SECRET,
};
