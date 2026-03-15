const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function setMock(relPath, exports) {
  const abs = path.resolve(__dirname, "..", relPath);
  const resolved = require.resolve(abs);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function makeAdminMock() {
  return {
    firestore: {
      Timestamp: {
        now() { return { toDate() { return new Date("2026-01-01T00:00:00.000Z"); } }; },
        fromDate(d) { return { toDate() { return d; } }; },
      },
      FieldPath: { documentId() { return "__name__"; } },
      FieldValue: { serverTimestamp: () => "server-ts" },
    },
  };
}

function loadReviewService(dbMock) {
  process.env.REVIEW_ID_SALT = "test-salt";

  setMock("src/config/firebase.js", { db: dbMock, admin: makeAdminMock() });
  setMock("src/utils/timestamps.js", {
    updatedTimestamp: () => ({ updatedAt: "server-ts" }),
  });
  setMock("src/utils/cityStats.js", {
    normalizeRatings: (r) => r || {},
    addRatings: (a, b) => ({ ...a, ...b }),
    subRatings: (a, b) => a,
    assertSumsNonNegative: () => {},
    computeAverages: () => ({}),
    normalizeFlatCityMetrics: () => ({}),
    computeLivabilityV0: () => ({ score: 75 }),
  });

  const p = require.resolve("../src/services/reviewService");
  delete require.cache[p];
  return require("../src/services/reviewService");
}

// ─── listReviewsForCity — cursor validation ───────────────────────────────────

describe("reviewService.listReviewsForCity — cursor validation", () => {
  function makeQueryDb(docsToReturn = []) {
    return {
      collection() {
        return {
          where() { return this; },
          orderBy() { return this; },
          limit() { return this; },
          startAfter() { return this; },
          async get() { return { docs: docsToReturn }; },
          doc() { return { async get() { return { exists: false }; } }; },
        };
      },
    };
  }

  it("throws 400 when cursor has id but no createdAt", async () => {
    const { listReviewsForCity } = loadReviewService(makeQueryDb());

    await assert.rejects(
      () => listReviewsForCity({ cityId: "portland-or", pageSize: 10, cursor: { id: "abc" } }),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.code, "BAD_CURSOR");
        return true;
      },
    );
  });

  it("throws 400 when cursor has createdAt but no id", async () => {
    const { listReviewsForCity } = loadReviewService(makeQueryDb());

    await assert.rejects(
      () => listReviewsForCity({
        cityId: "portland-or",
        pageSize: 10,
        cursor: { createdAt: { toDate() { return new Date(); } } },
      }),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.code, "BAD_CURSOR");
        return true;
      },
    );
  });

  it("returns docs when no cursor is provided", async () => {
    const fakeDoc = {
      id: "review-1",
      data() { return { cityId: "portland-or", ratings: {}, createdAt: null }; },
    };
    const { listReviewsForCity } = loadReviewService(makeQueryDb([fakeDoc]));

    const docs = await listReviewsForCity({ cityId: "portland-or", pageSize: 10, cursor: null });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].id, "review-1");
  });

  it("returns docs when a valid full cursor is provided", async () => {
    const { listReviewsForCity } = loadReviewService(makeQueryDb([]));
    const ts = { toDate() { return new Date("2026-01-01T00:00:00.000Z"); } };

    const docs = await listReviewsForCity({
      cityId: "portland-or",
      pageSize: 10,
      cursor: { id: "abc", createdAt: ts },
    });
    assert.equal(docs.length, 0);
  });
});

// ─── getReviewByIdForCity ─────────────────────────────────────────────────────

describe("reviewService.getReviewByIdForCity", () => {
  it("returns null when the review doc does not exist", async () => {
    const dbMock = {
      collection() {
        return {
          doc() {
            return { async get() { return { exists: false }; } };
          },
        };
      },
    };

    const { getReviewByIdForCity } = loadReviewService(dbMock);
    const result = await getReviewByIdForCity({ cityId: "portland-or", reviewId: "nope" });
    assert.equal(result, null);
  });

  it("returns null when the review belongs to a different city", async () => {
    const dbMock = {
      collection() {
        return {
          doc() {
            return {
              async get() {
                return {
                  exists: true,
                  id: "review-1",
                  data() { return { cityId: "seattle-wa" }; },
                };
              },
            };
          },
        };
      },
    };

    const { getReviewByIdForCity } = loadReviewService(dbMock);
    const result = await getReviewByIdForCity({ cityId: "portland-or", reviewId: "review-1" });
    assert.equal(result, null);
  });

  it("returns { id, data } when the review exists and cityId matches", async () => {
    const dbMock = {
      collection() {
        return {
          doc() {
            return {
              async get() {
                return {
                  exists: true,
                  id: "review-1",
                  data() { return { cityId: "portland-or", ratings: { overall: 7 } }; },
                };
              },
            };
          },
        };
      },
    };

    const { getReviewByIdForCity } = loadReviewService(dbMock);
    const result = await getReviewByIdForCity({ cityId: "portland-or", reviewId: "review-1" });

    assert.ok(result);
    assert.equal(result.id, "review-1");
    assert.equal(result.data.cityId, "portland-or");
    assert.equal(result.data.ratings.overall, 7);
  });
});
