// src/middleware/requireAuth.js
const jwt = require("jsonwebtoken");
const { NODE_ENV, DEV_AUTH_BYPASS } = require("../config/env");

function isLocalhostIp(ip) {
  const s = String(ip || "");
  return s === "127.0.0.1" || s === "::1" || s === "::ffff:127.0.0.1";
}

function isStateChangingMethod(req) {
  const m = String(req.method || "").toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

/**
 * CSRF-lite:
 * Require a custom header for state-changing requests.
 * This blocks "drive-by" cross-site form submits because browsers can't set custom headers in HTML forms.
 */
function enforceCsrfLite(req, res) {
  // Only for state-changing routes
  if (!isStateChangingMethod(req)) return true;

  // If you ever add webhooks or server-to-server calls, you can exempt them here.
  // Example:
  // if (req.path.startsWith("/webhooks/")) return true;

  const xrw = req.get("x-requested-with");
  if (xrw !== "XMLHttpRequest") {
    res.status(403).json({
      error: { code: "CSRF", message: "Missing CSRF header" },
    });
    return false;
  }
  return true;
}

async function requireAuth(req, res, next) {
  try {
    const isProd = NODE_ENV === "production";
    const bypassEnabled =
      !isProd && String(DEV_AUTH_BYPASS).toLowerCase() === "true";

    // Dev bypass (localhost only)
    if (bypassEnabled) {
      if (!isLocalhostIp(req.ip)) {
        return res.status(401).json({
          error: {
            code: "UNAUTHENTICATED",
            message: "Dev auth bypass only from localhost.",
          },
        });
      }

      const devUser = String(req.header("x-dev-user") || "").trim();
      if (!devUser || devUser.length > 128) {
        return res.status(401).json({
          error: {
            code: "UNAUTHENTICATED",
            message: "Missing/invalid x-dev-user",
          },
        });
      }

      // Optional: enforce CSRF-lite even in bypass mode (usually unnecessary)
      // if (!enforceCsrfLite(req, res)) return;

      req.user = { sub: devUser, isDevBypass: true };
      return next();
    }

    // Require server secret
    if (!process.env.SESSION_JWT_SECRET) {
      return res.status(500).json({
        error: {
          code: "SERVER_MISCONFIG",
          message: "Missing SESSION_JWT_SECRET",
        },
      });
    }

    // CSRF-lite first (before doing work), but only after we know we're not in bypass
    if (!enforceCsrfLite(req, res)) return;

    // Cookie session
    const token = req.cookies?.ci_session;
    if (!token) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Missing session" },
      });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.SESSION_JWT_SECRET);
    } catch {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Invalid/expired session" },
      });
    }

    req.user = {
      sub: payload.sub,
      email: payload.email || null,
      name: payload.name || null,
      picture: payload.picture || null,
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAuth };
