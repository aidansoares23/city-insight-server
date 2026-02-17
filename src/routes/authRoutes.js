// src/routes/authRoutes.js
const express = require("express");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { GOOGLE_CLIENT_ID, NODE_ENV } = require("../config/env");

const router = express.Router();
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

function cookieOptions() {
  const isProd = NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd, // true on Render HTTPS
    sameSite: isProd ? "none" : "lax", // Vercel->Render is cross-site in prod
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  };
}

function requireCsrfLite(req, res, next) {
  const xrw = req.get("x-requested-with");
  if (xrw !== "XMLHttpRequest") {
    return res.status(403).json({
      error: { code: "CSRF", message: "Missing CSRF header" },
    });
  }
  next();
}

router.post("/login", requireCsrfLite, async (req, res, next) => {
  try {
    const idToken = String(req.body?.idToken || "").trim();
    if (!idToken) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Missing idToken" },
      });
    }
    if (!GOOGLE_CLIENT_ID) {
      return res.status(500).json({
        error: {
          code: "SERVER_MISCONFIG",
          message: "Missing GOOGLE_CLIENT_ID",
        },
      });
    }
    if (!process.env.SESSION_JWT_SECRET) {
      return res.status(500).json({
        error: {
          code: "SERVER_MISCONFIG",
          message: "Missing SESSION_JWT_SECRET",
        },
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();

    const sessionToken = jwt.sign(
      {
        sub: p.sub,
        email: p.email || null,
        name: p.name || null,
        picture: p.picture || null,
      },
      process.env.SESSION_JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.cookie("ci_session", sessionToken, cookieOptions());

    return res.json({
      ok: true,
      user: {
        sub: p.sub,
        email: p.email || null,
        name: p.name || null,
        picture: p.picture || null,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/logout", requireCsrfLite, (req, res) => {
  // Clear cookie (same options matter)
  res.clearCookie("ci_session", { ...cookieOptions(), maxAge: 0 });
  return res.json({ ok: true });
});

module.exports = router;
