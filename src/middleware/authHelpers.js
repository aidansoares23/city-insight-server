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
  return isLocalhostIp(derivedIp) && isLocalhostIp(socketIp) && !hasForwardedFor;
}

/**
 * Returns `true` when the dev auth bypass is enabled for this environment.
 * Reads env at call time (not at module init) so tests can mock env.js per-suite
 * without reloading this module.
 */
function isBypassEnabled() {
  const { NODE_ENV, DEV_AUTH_BYPASS } = require("../config/env");
  return NODE_ENV !== "production" && String(DEV_AUTH_BYPASS).toLowerCase() === "true";
}

/**
 * Resolves the dev-bypass user identity from an `x-dev-user` request header.
 * Returns `{ sub, isDevBypass: true }` on success, or `null` if the header is
 * absent/invalid or the request is not from localhost.
 *
 * Does NOT check whether bypass is globally enabled — callers must gate on
 * `isBypassEnabled()` first.
 */
function resolveDevBypassUser(req) {
  if (!isLocalDevRequest(req)) return null;
  const devUser = String(req.header("x-dev-user") || "").trim();
  if (!devUser || devUser.length > 128) return null;
  return { sub: devUser, isDevBypass: true };
}

module.exports = { isLocalDevRequest, isBypassEnabled, resolveDevBypassUser };
