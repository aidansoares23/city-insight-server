// // src/middleware/requireAuth.js
// const { NODE_ENV, DEV_AUTH_BYPASS, GOOGLE_CLIENT_ID } = require("../config/env");
// const { admin } = require("../config/firebase");
// const { OAuth2Client } = require("google-auth-library");

// const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// function isLocalhostIp(ip) {
//   // Express may provide IPv6/IPv4-mapped forms depending on proxy settings.
//   // Common localhost values:
//   // - 127.0.0.1
//   // - ::1
//   // - ::ffff:127.0.0.1
//   const s = String(ip || "");
//   return (
//     s === "127.0.0.1" ||
//     s === "::1" ||
//     s === "::ffff:127.0.0.1" ||
//     s.endsWith("127.0.0.1")
//   );
// }

// async function requireAuth(req, res, next) {
//   try {
//     const isProd = NODE_ENV === "production";

//     // ✅ Hard requirement: only bypass when explicitly enabled AND not prod
//     // Put DEV_AUTH_BYPASS="true" in local .env if you want this.
//     const bypassEnabled = !isProd && String(DEV_AUTH_BYPASS).toLowerCase() === "true";

//     // Dev-only bypass for local testing
//     if (bypassEnabled) {
//       // Optional extra safety: only allow from localhost
//       if (!isLocalhostIp(req.ip)) {
//         return res.status(401).json({
//           error: {
//             code: "UNAUTHENTICATED",
//             message: "Dev auth bypass is only allowed from localhost.",
//           },
//         });
//       }

//       const devUser = req.header("x-dev-user");
//       const cleaned = String(devUser || "").trim();

//       // Basic hygiene: avoid empty or huge values
//       if (!cleaned || cleaned.length > 128) {
//         return res.status(401).json({
//           error: {
//             code: "UNAUTHENTICATED",
//             message: "Missing or invalid x-dev-user in dev bypass mode",
//           },
//         });
//       }

//       req.user = { sub: cleaned, isDevBypass: true };
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
const { NODE_ENV, DEV_AUTH_BYPASS, GOOGLE_CLIENT_ID } = require("../config/env");
const { OAuth2Client } = require("google-auth-library");

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

function isLocalhostIp(ip) {
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
    const bypassEnabled = !isProd && String(DEV_AUTH_BYPASS).toLowerCase() === "true";

    if (bypassEnabled) {
      if (!isLocalhostIp(req.ip)) {
        return res.status(401).json({
          error: { code: "UNAUTHENTICATED", message: "Dev auth bypass is only allowed from localhost." },
        });
      }

      const devUser = String(req.header("x-dev-user") || "").trim();
      if (!devUser || devUser.length > 128) {
        return res.status(401).json({
          error: { code: "UNAUTHENTICATED", message: "Missing or invalid x-dev-user in dev bypass mode" },
        });
      }

      req.user = { sub: devUser, isDevBypass: true };
      return next();
    }

    const auth = String(req.header("authorization") || "").trim();
    const [scheme, token] = auth.split(/\s+/);

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Missing Authorization: Bearer <token>" },
      });
    }

    if (!GOOGLE_CLIENT_ID) {
      return res.status(500).json({
        error: { code: "SERVER_MISCONFIG", message: "Missing GOOGLE_CLIENT_ID on server." },
      });
    }

    // Verify Google ID token from @react-oauth/google
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (e) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Invalid or expired Google ID token." },
      });
    }

    req.user = {
      sub: payload.sub,
      email: payload.email || null,
      name: payload.name || null,
      picture: payload.picture || null,
      google: payload,
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAuth };
