const jwt = require("jsonwebtoken");
const { NODE_ENV, DEV_AUTH_BYPASS, SESSION_JWT_SECRET } = require("../config/env");

/**
 * Express middleware that optionally authenticates a request.
 * If a valid `ci_session` cookie is present, populates `req.user`.
 * If missing or invalid, sets `req.user = null` and proceeds — never returns 401.
 *
 * Supports the same dev-bypass as `requireAuth` for consistency in local development.
 */
async function optionalAuth(req, res, next) {
  try {
    const isProd = NODE_ENV === "production";
    const bypassEnabled = !isProd && String(DEV_AUTH_BYPASS).toLowerCase() === "true";

    if (bypassEnabled) {
      const devUser = String(req.header("x-dev-user") || "").trim();
      if (devUser && devUser.length <= 128) {
        req.user = { sub: devUser, isDevBypass: true };
      } else {
        req.user = null;
      }
      return next();
    }

    const token = req.cookies?.ci_session;
    if (!token) {
      req.user = null;
      return next();
    }

    try {
      const payload = jwt.verify(token, SESSION_JWT_SECRET);
      req.user = {
        sub: payload.sub,
        email: payload.email || null,
        name: payload.name || null,
        picture: payload.picture || null,
      };
    } catch {
      // Invalid or expired — treat as unauthenticated rather than erroring
      req.user = null;
    }

    return next();
  } catch (err) {
    // Safety net — always proceed even if something unexpected throws
    req.user = null;
    return next();
  }
}

module.exports = { optionalAuth };
