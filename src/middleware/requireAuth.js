const jwt = require("jsonwebtoken");
const { NODE_ENV, DEV_AUTH_BYPASS, SESSION_JWT_SECRET } = require("../config/env");

/** Returns `true` if `ip` is a loopback address (`127.0.0.1`, `::1`, or `::ffff:127.0.0.1`). */
function isLocalhostIp(ip) {
  const ipStr = String(ip || "");
  return ipStr === "127.0.0.1" || ipStr === "::1" || ipStr === "::ffff:127.0.0.1";
}

/**
 * Returns `true` if the request originates from localhost with no `x-forwarded-for` header.
 * Used to gate the dev auth bypass so it can never be triggered from a proxied/remote request.
 */
function isLocalDevRequest(req) {
  const derivedIp = req.ip;
  const socketIp = req.socket?.remoteAddress;
  const hasForwardedFor = Boolean(req.headers["x-forwarded-for"]);

  return (
    isLocalhostIp(derivedIp) && isLocalhostIp(socketIp) && !hasForwardedFor
  );
}

/** Returns `true` for POST, PUT, PATCH, and DELETE requests. */
function isStateChangingMethod(req) {
  const method = String(req.method || "").toUpperCase();
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

/**
 * CSRF-lite check: verifies that state-changing requests include `X-Requested-With: XMLHttpRequest`.
 * Browsers cannot set custom headers in plain HTML form submits, so this blocks cross-site form attacks.
 * Returns `true` if the request passes; writes a 403 and returns `false` if it fails.
 */
function enforceCsrfLite(req, res) {
  if (!isStateChangingMethod(req)) return true;

  const xRequestedWith = req.get("x-requested-with");
  if (xRequestedWith !== "XMLHttpRequest") {
    res.status(403).json({
      error: { code: "CSRF", message: "Missing CSRF header" },
    });
    return false;
  }
  return true;
}

/**
 * Express middleware that enforces authentication on a route.
 * In non-production with `DEV_AUTH_BYPASS=true`, allows localhost requests bearing an `x-dev-user` header.
 * Otherwise verifies the `ci_session` JWT cookie and enforces the CSRF-lite header on state-changing methods.
 * Populates `req.user` with `{ sub, email, name, picture }` on success.
 */
async function requireAuth(req, res, next) {
  try {
    const isProd = NODE_ENV === "production";
    const bypassEnabled =
      !isProd && String(DEV_AUTH_BYPASS).toLowerCase() === "true";

    if (bypassEnabled) {
      if (!isLocalDevRequest(req)) {
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

      req.user = { sub: devUser, isDevBypass: true };
      return next();
    }

    if (!enforceCsrfLite(req, res)) return;

    const token = req.cookies?.ci_session;
    if (!token) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Missing session" },
      });
    }

    let payload;
    try {
      payload = jwt.verify(token, SESSION_JWT_SECRET);
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
