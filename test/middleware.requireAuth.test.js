const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const jwt = require("jsonwebtoken");

const TEST_SECRET = "test-jwt-secret";

function setMock(relPath, exports) {
  const abs = path.resolve(__dirname, "..", relPath);
  const resolved = require.resolve(abs);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function loadRequireAuth({ NODE_ENV = "development", DEV_AUTH_BYPASS = false, SESSION_JWT_SECRET = TEST_SECRET } = {}) {
  const p = require.resolve("../src/middleware/requireAuth");
  delete require.cache[p];
  setMock("src/config/env", { NODE_ENV, DEV_AUTH_BYPASS, GOOGLE_CLIENT_ID: "", SESSION_JWT_SECRET });
  return require("../src/middleware/requireAuth").requireAuth;
}

function fakeReq({ method = "GET", ip = "127.0.0.1", socketIp = "127.0.0.1", headers = {}, cookies = {} } = {}) {
  return {
    method,
    ip,
    socket: { remoteAddress: socketIp },
    headers,
    cookies,
    header: (name) => headers[name.toLowerCase()],
    get: (name) => headers[name.toLowerCase()],
  };
}

function fakeRes() {
  const r = {
    _status: null,
    _body: null,
    status(code) { r._status = code; return r; },
    json(body) { r._body = body; return r; },
  };
  return r;
}

// ─── Dev bypass ───────────────────────────────────────────────────────────────

describe("requireAuth — dev bypass", () => {
  let requireAuth;
  before(() => {
    requireAuth = loadRequireAuth({ NODE_ENV: "development", DEV_AUTH_BYPASS: true });
  });

  it("localhost + valid x-dev-user → next(), req.user set", async () => {
    const req = fakeReq({ headers: { "x-dev-user": "alice" } });
    const res = fakeRes();
    let called = false;
    await requireAuth(req, res, () => { called = true; });
    assert.ok(called);
    assert.deepEqual(req.user, { sub: "alice", isDevBypass: true });
  });

  it("x-dev-user header is trimmed", async () => {
    const req = fakeReq({ headers: { "x-dev-user": "  bob  " } });
    const res = fakeRes();
    await requireAuth(req, res, () => {});
    assert.equal(req.user.sub, "bob");
  });

  it("non-localhost ip → 401", async () => {
    const req = fakeReq({ ip: "1.2.3.4", socketIp: "1.2.3.4", headers: { "x-dev-user": "alice" } });
    const res = fakeRes();
    await requireAuth(req, res, () => {});
    assert.equal(res._status, 401);
    assert.equal(res._body.error.code, "UNAUTHENTICATED");
  });

  it("x-forwarded-for present → 401 (treats as non-local)", async () => {
    const req = fakeReq({ headers: { "x-forwarded-for": "1.2.3.4", "x-dev-user": "alice" } });
    const res = fakeRes();
    await requireAuth(req, res, () => {});
    assert.equal(res._status, 401);
  });

  it("missing x-dev-user → 401", async () => {
    const req = fakeReq({});
    const res = fakeRes();
    await requireAuth(req, res, () => {});
    assert.equal(res._status, 401);
    assert.equal(res._body.error.code, "UNAUTHENTICATED");
  });

  it("x-dev-user over 128 chars → 401", async () => {
    const req = fakeReq({ headers: { "x-dev-user": "a".repeat(129) } });
    const res = fakeRes();
    await requireAuth(req, res, () => {});
    assert.equal(res._status, 401);
  });
});

// ─── JWT / production path ────────────────────────────────────────────────────

describe("requireAuth — JWT mode", () => {
  let requireAuth;
  before(() => {
    requireAuth = loadRequireAuth({ NODE_ENV: "production", DEV_AUTH_BYPASS: false });
  });

  // SESSION_JWT_SECRET validation moved to env.js startup (throws in production if missing).
  // requireAuth reads it as an imported constant, so missing-secret is a deploy-time error, not runtime.

  it("POST without X-Requested-With → 403 CSRF", async () => {
    const req = fakeReq({ method: "POST" });
    const res = fakeRes();
    await requireAuth(req, res, () => {});
    assert.equal(res._status, 403);
    assert.equal(res._body.error.code, "CSRF");
  });

  it("PUT/PATCH/DELETE without X-Requested-With → 403 CSRF", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const req = fakeReq({ method });
      const res = fakeRes();
      await requireAuth(req, res, () => {});
      assert.equal(res._status, 403, `expected CSRF block for ${method}`);
    }
  });

  it("GET without X-Requested-With → not blocked by CSRF (falls through to session check)", async () => {
    const req = fakeReq({ method: "GET" });
    const res = fakeRes();
    await requireAuth(req, res, () => {});
    assert.equal(res._status, 401);
    assert.equal(res._body.error.code, "UNAUTHENTICATED");
  });

  it("POST with CSRF header but no session cookie → 401", async () => {
    const req = fakeReq({ method: "POST", headers: { "x-requested-with": "XMLHttpRequest" } });
    const res = fakeRes();
    await requireAuth(req, res, () => {});
    assert.equal(res._status, 401);
    assert.equal(res._body.error.code, "UNAUTHENTICATED");
  });

  it("POST with CSRF header and invalid token → 401", async () => {
    const req = fakeReq({
      method: "POST",
      headers: { "x-requested-with": "XMLHttpRequest" },
      cookies: { ci_session: "bad.token.here" },
    });
    const res = fakeRes();
    await requireAuth(req, res, () => {});
    assert.equal(res._status, 401);
    assert.equal(res._body.error.code, "UNAUTHENTICATED");
  });

  it("POST with CSRF header and expired JWT → 401", async () => {
    const token = jwt.sign({ sub: "user-1" }, TEST_SECRET, { expiresIn: "-1s" });
    const req = fakeReq({
      method: "POST",
      headers: { "x-requested-with": "XMLHttpRequest" },
      cookies: { ci_session: token },
    });
    const res = fakeRes();
    await requireAuth(req, res, () => {});
    assert.equal(res._status, 401);
    assert.equal(res._body.error.code, "UNAUTHENTICATED");
  });

  it("POST with CSRF header and valid JWT → next(), req.user set correctly", async () => {
    const token = jwt.sign(
      { sub: "user-123", email: "alice@example.com", name: "Alice", picture: "https://example.com/pic.jpg" },
      TEST_SECRET,
    );
    const req = fakeReq({
      method: "POST",
      headers: { "x-requested-with": "XMLHttpRequest" },
      cookies: { ci_session: token },
    });
    const res = fakeRes();
    let called = false;
    await requireAuth(req, res, () => { called = true; });
    assert.ok(called);
    assert.equal(req.user.sub, "user-123");
    assert.equal(req.user.email, "alice@example.com");
    assert.equal(req.user.name, "Alice");
    assert.equal(req.user.picture, "https://example.com/pic.jpg");
  });

  it("GET with valid JWT and no CSRF header → next() (GET is not state-changing)", async () => {
    const token = jwt.sign({ sub: "user-456" }, TEST_SECRET);
    const req = fakeReq({
      method: "GET",
      cookies: { ci_session: token },
    });
    const res = fakeRes();
    let called = false;
    await requireAuth(req, res, () => { called = true; });
    assert.ok(called);
    assert.equal(req.user.sub, "user-456");
  });

  it("JWT payload missing optional fields → req.user fields are null", async () => {
    const token = jwt.sign({ sub: "user-789" }, TEST_SECRET);
    const req = fakeReq({
      method: "GET",
      cookies: { ci_session: token },
    });
    const res = fakeRes();
    await requireAuth(req, res, () => {});
    assert.equal(req.user.email, null);
    assert.equal(req.user.name, null);
    assert.equal(req.user.picture, null);
  });
});

// ─── Bypass disabled in production ───────────────────────────────────────────

describe("requireAuth — bypass disabled in production", () => {
  it("NODE_ENV=production ignores DEV_AUTH_BYPASS", async () => {
    const requireAuth = loadRequireAuth({ NODE_ENV: "production", DEV_AUTH_BYPASS: false });
    const req = fakeReq({ method: "GET", headers: { "x-dev-user": "hacker" } });
    const res = fakeRes();
    await requireAuth(req, res, () => {});
    // Falls through to session check, not the bypass path
    assert.equal(res._status, 401);
    assert.equal(res._body.error.message, "Missing session");
  });
});
