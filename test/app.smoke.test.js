const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { once } = require("node:events");

process.env.NODE_ENV = "development";
process.env.DEV_AUTH_BYPASS = "true";
process.env.SESSION_JWT_SECRET = "test-session-secret";
process.env.REVIEW_ID_SALT = "test-review-salt";
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";

const projectRoot = path.resolve(__dirname, "..");

function setMock(relativePath, exportsValue) {
  const absPath = path.join(projectRoot, relativePath);
  const resolved = require.resolve(absPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function fixedTs() {
  return {
    toDate() {
      return new Date("2026-01-01T00:00:00.000Z");
    },
  };
}

setMock("src/config/firebase.js", {
  admin: {
    firestore: {
      Timestamp: {
        fromDate(date) {
          return {
            toDate() {
              return date;
            },
          };
        },
      },
      FieldPath: {
        documentId() {
          return "__name__";
        },
      },
    },
  },
  db: {},
});

setMock("src/services/cityService.js", {
  async listCities({ limit, q, sort }) {
    return {
      cities: [
        {
          id: "san-francisco-ca",
          slug: "san-francisco-ca",
          name: "San Francisco",
          state: "CA",
          reviewCount: 3,
          livabilityScore: 78,
          safetyScore: 6.5,
          medianRent: 3400,
          crimeIndexPer100k: 2350,
        },
      ],
      meta: { limit, q: q || null, sort },
    };
  },
  async getCityBySlug() {
    return null;
  },
  async getCityDetails() {
    return { city: null, stats: null, metrics: null, livability: null, reviews: [] };
  },
});

setMock("src/services/reviewService.js", {
  async upsertMyReviewForCity({ cityId, userId, incomingRatings, incomingComment }) {
    return {
      created: true,
      reviewId: "review-123",
      review: {
        cityId,
        userId,
        ratings: incomingRatings,
        comment: incomingComment,
        createdAt: fixedTs(),
        updatedAt: fixedTs(),
      },
    };
  },
  async getMyReviewForCity() {
    return { reviewId: "review-123", review: null };
  },
  async deleteMyReviewForCity() {
    return { deleted: true };
  },
  async listReviewsForCity() {
    return [];
  },
  async getReviewByIdForCity() {
    return null;
  },
});

setMock("src/services/meService.js", {
  async upsertMeFromAuthClaims(claims) {
    return { sub: claims?.sub || "dev-user", created: false, user: {} };
  },
  async listMyReviews() {
    return [];
  },
});

const app = require("../src/app");

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
});

async function requestJson(urlPath, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...headers,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const payload = await response.json();
  return { response, payload };
}

test("GET /health returns API status", async () => {
  const { response, payload } = await requestJson("/health");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "city-insight-api");
});

test("POST /api/auth/login requires csrf-lite header", async () => {
  const { response, payload } = await requestJson("/api/auth/login", {
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 403);
  assert.equal(payload.error.code, "CSRF");
});

test("GET /api/cities returns list payload", async () => {
  const { response, payload } = await requestJson(
    "/api/cities?limit=5&sort=name_asc",
  );
  assert.equal(response.status, 200);
  assert.equal(Array.isArray(payload.cities), true);
  assert.equal(payload.cities.length, 1);
  assert.equal(payload.cities[0].slug, "san-francisco-ca");
});

test("POST /api/cities/:slug/reviews rejects invalid review body", async () => {
  const { response, payload } = await requestJson(
    "/api/cities/san-francisco-ca/reviews",
    {
      method: "POST",
      headers: { "x-dev-user": "dev-user-1" },
      body: {
        ratings: {
          safety: 0,
          cost: 11,
          traffic: 5,
          cleanliness: 5,
          overall: 5,
        },
        comment: "bad ratings",
      },
    },
  );

  assert.equal(response.status, 400);
  assert.equal(payload.error.code, "VALIDATION_ERROR");
});

test("POST /api/cities/:slug/reviews accepts valid body", async () => {
  const { response, payload } = await requestJson(
    "/api/cities/san-francisco-ca/reviews",
    {
      method: "POST",
      headers: { "x-dev-user": "dev-user-2" },
      body: {
        ratings: {
          safety: 7,
          cost: 4,
          traffic: 5,
          cleanliness: 6,
          overall: 6,
        },
        comment: "Great city with tradeoffs.",
      },
    },
  );

  assert.equal(response.status, 201);
  assert.equal(payload.ok, true);
  assert.equal(payload.created, true);
  assert.equal(payload.review.cityId, "san-francisco-ca");
  assert.equal(payload.review.userId, "dev-user-2");
});

test("GET /api/cities/:slug returns 404 for unknown city", async () => {
  const { response, payload } = await requestJson("/api/cities/nonexistent-city-ca");
  assert.equal(response.status, 404);
  assert.equal(payload.error.code, "NOT_FOUND");
});

test("DELETE /api/cities/:slug/reviews/me deletes review with dev auth", async () => {
  const { response, payload } = await requestJson(
    "/api/cities/san-francisco-ca/reviews/me",
    {
      method: "DELETE",
      headers: { "x-dev-user": "dev-user-3" },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.deleted, true);
});

test("GET /api/cities/:slug/reviews requires no auth and returns list shape", async () => {
  const { response, payload } = await requestJson(
    "/api/cities/san-francisco-ca/reviews",
  );
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(payload.reviews));
  assert.ok("pageSize" in payload);
  assert.ok("nextCursor" in payload);
});
