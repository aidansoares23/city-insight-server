const jwt = require("jsonwebtoken");
const { NODE_ENV, DEV_AUTH_BYPASS } = require("../config/env");

function isLocalhostIp(ip) {
  const ipStr = String(ip || "");
  return ipStr === "127.0.0.1" || ipStr === "::1" || ipStr === "::ffff:127.0.0.1";
}

function isLocalDevRequest(req) {
  const derivedIp = req.ip;
  const socketIp = req.socket?.remoteAddress;
  const hasForwardedFor = Boolean(req.headers["x-forwarded-for"]);

  return (
    isLocalhostIp(derivedIp) && isLocalhostIp(socketIp) && !hasForwardedFor
  );
}

function isStateChangingMethod(req) {
  const method = String(req.method || "").toUpperCase();
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

// Blocks cross-site form submits — browsers can't set custom headers in HTML forms.
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

    if (!process.env.SESSION_JWT_SECRET) {
      return res.status(500).json({
        error: {
          code: "SERVER_MISCONFIG",
          message: "Missing SESSION_JWT_SECRET",
        },
      });
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
