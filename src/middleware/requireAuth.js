// // src/middleware/requireAuth.js
// const { NODE_ENV, DEV_AUTH_BYPASS } = require("../config/env");
// const { admin } = require("../config/firebase");

// async function requireAuth(req, res, next) {
//   try {
//     const isProd = NODE_ENV === "production";
//     const bypass = !isProd && DEV_AUTH_BYPASS;

//     // Dev-only bypass for local testing
//     if (bypass) {
//       const devUser = req.header("x-dev-user");
//       if (!devUser) {
//         return res.status(401).json({
//           error: {
//             code: "UNAUTHENTICATED",
//             message: "Missing x-dev-user in dev bypass mode",
//           },
//         });
//       }

//       req.user = { sub: String(devUser), isDevBypass: true };
//       return next();
//     }

//     const auth = String(req.header("authorization") || "").trim();
//     const [scheme, token] = auth.split(/\s+/); // handles extra spaces

//     if (scheme !== "Bearer" || !token) {
//       return res.status(401).json({
//         error: {
//           code: "UNAUTHENTICATED",
//           message: "Missing Authorization: Bearer <token>",
//         },
//       });
//     }

//     // Verify Firebase Auth ID token
//     let decoded;
//     try {
//       decoded = await admin.auth().verifyIdToken(token);
//     } catch (e) {
//       return res.status(401).json({
//         error: {
//           code: "UNAUTHENTICATED",
//           message: "Invalid or expired auth token.",
//         },
//       });
//     }

//     req.user = {
//       sub: decoded.uid,
//       email: decoded.email || null,
//       name: decoded.name || null,
//       picture: decoded.picture || null,
//       firebase: decoded,
//     };

//     return next();
//   } catch (err) {
//     return next(err);
//   }
// }

// module.exports = { requireAuth };

// src/middleware/requireAuth.js
const { NODE_ENV, DEV_AUTH_BYPASS } = require("../config/env");
const { admin } = require("../config/firebase");

function isLocalhostIp(ip) {
  // Express may provide IPv6/IPv4-mapped forms depending on proxy settings.
  // Common localhost values:
  // - 127.0.0.1
  // - ::1
  // - ::ffff:127.0.0.1
  const s = String(ip || "");
  return (
    s === "127.0.0.1" ||
    s === "::1" ||
    s === "::ffff:127.0.0.1" ||
    s.endsWith("127.0.0.1")
  );
}

async function requireAuth(req, res, next) {
  try {
    const isProd = NODE_ENV === "production";

    // ✅ Hard requirement: only bypass when explicitly enabled AND not prod
    // Put DEV_AUTH_BYPASS="true" in local .env if you want this.
    const bypassEnabled = !isProd && String(DEV_AUTH_BYPASS).toLowerCase() === "true";

    // Dev-only bypass for local testing
    if (bypassEnabled) {
      // Optional extra safety: only allow from localhost
      if (!isLocalhostIp(req.ip)) {
        return res.status(401).json({
          error: {
            code: "UNAUTHENTICATED",
            message: "Dev auth bypass is only allowed from localhost.",
          },
        });
      }

      const devUser = req.header("x-dev-user");
      const cleaned = String(devUser || "").trim();

      // Basic hygiene: avoid empty or huge values
      if (!cleaned || cleaned.length > 128) {
        return res.status(401).json({
          error: {
            code: "UNAUTHENTICATED",
            message: "Missing or invalid x-dev-user in dev bypass mode",
          },
        });
      }

      req.user = { sub: cleaned, isDevBypass: true };
      return next();
    }

    const auth = String(req.header("authorization") || "").trim();
    const [scheme, token] = auth.split(/\s+/); // handles extra spaces

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Missing Authorization: Bearer <token>",
        },
      });
    }

    // Verify Firebase Auth ID token
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(token);
    } catch (e) {
      return res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Invalid or expired auth token.",
        },
      });
    }

    req.user = {
      sub: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || null,
      picture: decoded.picture || null,
      firebase: decoded,
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAuth };
