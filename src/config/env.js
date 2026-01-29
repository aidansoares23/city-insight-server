// src/config/env.js
function parseBool(val) {
  return String(val || "").trim().toLowerCase() === "true";
}

const NODE_ENV = process.env.NODE_ENV || "development";
const DEV_AUTH_BYPASS = parseBool(process.env.DEV_AUTH_BYPASS);

// Fail closed: never allow bypass outside dev
if (NODE_ENV === "production" && DEV_AUTH_BYPASS) {
  throw new Error(
    "SECURITY: DEV_AUTH_BYPASS=true is not allowed in production. Set DEV_AUTH_BYPASS=false."
  );
}

module.exports = {
  NODE_ENV,
  DEV_AUTH_BYPASS,
};
