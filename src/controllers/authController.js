const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { GOOGLE_CLIENT_ID, NODE_ENV } = require("../config/env");

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

function cookieOptions() {
  const isProd = NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  };
}

async function login(req, res, next) {
  try {
    const idToken = String(req.body?.idToken || "").trim();
    if (!idToken) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Missing idToken" },
      });
    }
    if (!GOOGLE_CLIENT_ID) {
      return res.status(500).json({
        error: { code: "SERVER_MISCONFIG", message: "Missing GOOGLE_CLIENT_ID" },
      });
    }
    if (!process.env.SESSION_JWT_SECRET) {
      return res.status(500).json({
        error: { code: "SERVER_MISCONFIG", message: "Missing SESSION_JWT_SECRET" },
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const googlePayload = ticket.getPayload();

    const sessionToken = jwt.sign(
      {
        sub: googlePayload.sub,
        email: googlePayload.email || null,
        name: googlePayload.name || null,
        picture: googlePayload.picture || null,
      },
      process.env.SESSION_JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.cookie("ci_session", sessionToken, cookieOptions());

    return res.json({
      ok: true,
      user: {
        sub: googlePayload.sub,
        email: googlePayload.email || null,
        name: googlePayload.name || null,
        picture: googlePayload.picture || null,
      },
    });
  } catch (err) {
    return next(err);
  }
}

function logout(_req, res) {
  res.clearCookie("ci_session", { ...cookieOptions(), maxAge: 0 });
  return res.json({ ok: true });
}

module.exports = { login, logout };
