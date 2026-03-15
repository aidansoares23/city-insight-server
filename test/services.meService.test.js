const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function setMock(relPath, exports) {
  const abs = path.resolve(__dirname, "..", relPath);
  const resolved = require.resolve(abs);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function makeFakeTs() {
  return { toDate() { return new Date("2026-01-01T00:00:00.000Z"); } };
}

function loadMeService({ dbMock, deleteMyReviewForCity }) {
  setMock("src/config/firebase.js", {
    db: dbMock,
    admin: { firestore: { FieldValue: { serverTimestamp: () => "server-ts" } } },
  });
  setMock("src/utils/timestamps.js", {
    updatedTimestamp: () => ({ updatedAt: "server-ts" }),
    serverTimestamps: () => ({ createdAt: "server-ts", updatedAt: "server-ts" }),
  });
  setMock("src/lib/firestore.js", {
    tsToIso(ts) {
      if (!ts) return null;
      if (typeof ts.toDate === "function") return ts.toDate().toISOString();
      return null;
    },
  });
  setMock("src/services/reviewService.js", { deleteMyReviewForCity });

  const p = require.resolve("../src/services/meService");
  delete require.cache[p];
  return require("../src/services/meService");
}

// ─── deleteAccount ────────────────────────────────────────────────────────────

describe("meService.deleteAccount", () => {
  it("deletes all reviews and the user document", async () => {
    const deleted = [];
    const userDeleted = [];

    const dbMock = {
      collection(name) {
        if (name === "reviews") {
          return {
            where() { return this; },
            async get() {
              return {
                docs: [
                  { data() { return { cityId: "portland-or" }; } },
                  { data() { return { cityId: "seattle-wa" }; } },
                ],
              };
            },
          };
        }
        if (name === "users") {
          return { doc(uid) { return { async delete() { userDeleted.push(uid); } }; } };
        }
      },
    };

    const { deleteAccount } = loadMeService({
      dbMock,
      deleteMyReviewForCity: async ({ cityId }) => { deleted.push(cityId); },
    });

    const result = await deleteAccount({ userId: "user-1" });

    assert.deepEqual(result, { deleted: true });
    assert.deepEqual(deleted.sort(), ["portland-or", "seattle-wa"]);
    assert.deepEqual(userDeleted, ["user-1"]);
  });

  it("still deletes user document when a review deletion fails with a non-404 error", async () => {
    const userDeleted = [];

    const dbMock = {
      collection(name) {
        if (name === "reviews") {
          return {
            where() { return this; },
            async get() {
              return {
                docs: [
                  { data() { return { cityId: "portland-or" }; } },
                  { data() { return { cityId: "seattle-wa" }; } },
                ],
              };
            },
          };
        }
        if (name === "users") {
          return { doc(uid) { return { async delete() { userDeleted.push(uid); } }; } };
        }
      },
    };

    let callCount = 0;
    const { deleteAccount } = loadMeService({
      dbMock,
      deleteMyReviewForCity: async () => {
        callCount++;
        if (callCount === 1) throw Object.assign(new Error("Network error"), { code: "UNAVAILABLE" });
      },
    });

    const result = await deleteAccount({ userId: "user-2" });

    // User is still deleted despite one review failing
    assert.deepEqual(result, { deleted: true });
    assert.deepEqual(userDeleted, ["user-2"]);
  });

  it("ignores NOT_FOUND errors (review already deleted) without blocking user deletion", async () => {
    const userDeleted = [];

    const dbMock = {
      collection(name) {
        if (name === "reviews") {
          return {
            where() { return this; },
            async get() {
              return {
                docs: [{ data() { return { cityId: "austin-tx" }; } }],
              };
            },
          };
        }
        if (name === "users") {
          return { doc(uid) { return { async delete() { userDeleted.push(uid); } }; } };
        }
      },
    };

    const { deleteAccount } = loadMeService({
      dbMock,
      deleteMyReviewForCity: async () => {
        throw Object.assign(new Error("Review not found"), { code: "NOT_FOUND" });
      },
    });

    const result = await deleteAccount({ userId: "user-3" });

    assert.deepEqual(result, { deleted: true });
    assert.deepEqual(userDeleted, ["user-3"]);
  });

  it("throws 401 when userId is missing", async () => {
    const { deleteAccount } = loadMeService({
      dbMock: { collection() {} },
      deleteMyReviewForCity: async () => {},
    });

    await assert.rejects(
      () => deleteAccount({ userId: "" }),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.code, "UNAUTHENTICATED");
        return true;
      },
    );
  });

  it("skips docs with no cityId", async () => {
    const deleted = [];
    const userDeleted = [];

    const dbMock = {
      collection(name) {
        if (name === "reviews") {
          return {
            where() { return this; },
            async get() {
              return {
                docs: [
                  { data() { return { cityId: "denver-co" }; } },
                  { data() { return {}; } }, // no cityId
                ],
              };
            },
          };
        }
        if (name === "users") {
          return { doc(uid) { return { async delete() { userDeleted.push(uid); } }; } };
        }
      },
    };

    const { deleteAccount } = loadMeService({
      dbMock,
      deleteMyReviewForCity: async ({ cityId }) => { deleted.push(cityId); },
    });

    await deleteAccount({ userId: "user-4" });

    assert.deepEqual(deleted, ["denver-co"]);
  });
});

// ─── listMyReviews ────────────────────────────────────────────────────────────

describe("meService.listMyReviews", () => {
  it("returns mapped reviews with ISO timestamps", async () => {
    const ts = makeFakeTs();

    const dbMock = {
      collection() {
        return {
          where() { return this; },
          orderBy() { return this; },
          limit() { return this; },
          async get() {
            return {
              docs: [
                {
                  id: "review-abc",
                  data() {
                    return {
                      cityId: "portland-or",
                      ratings: { overall: 8 },
                      comment: "Great",
                      isEdited: false,
                      createdAt: ts,
                      updatedAt: ts,
                    };
                  },
                },
              ],
            };
          },
        };
      },
    };

    const { listMyReviews } = loadMeService({
      dbMock,
      deleteMyReviewForCity: async () => {},
    });

    const reviews = await listMyReviews({ userId: "user-1", limit: 10 });

    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].id, "review-abc");
    assert.equal(reviews[0].cityId, "portland-or");
    assert.equal(reviews[0].createdAt, "2026-01-01T00:00:00.000Z");
  });

  it("throws 401 when userId is missing", async () => {
    const { listMyReviews } = loadMeService({
      dbMock: { collection() {} },
      deleteMyReviewForCity: async () => {},
    });

    await assert.rejects(
      () => listMyReviews({ userId: "" }),
      (err) => { assert.equal(err.status, 401); return true; },
    );
  });
});

// ─── upsertMeFromAuthClaims ───────────────────────────────────────────────────

describe("meService.upsertMeFromAuthClaims", () => {
  it("creates a new user doc when none exists (created: true)", async () => {
    const written = [];

    const dbMock = {
      collection() {
        return {
          doc() {
            return {
              async get() { return { exists: false }; },
              async set(data) { written.push(data); },
            };
          },
        };
      },
    };

    const { upsertMeFromAuthClaims } = loadMeService({
      dbMock,
      deleteMyReviewForCity: async () => {},
    });

    // Second get (savedSnap) also needs to return data
    let getCallCount = 0;
    dbMock.collection = () => ({
      doc() {
        return {
          async get() {
            getCallCount++;
            if (getCallCount === 1) return { exists: false };
            return { exists: true, data() { return { uid: "sub-1", email: "a@b.com" }; } };
          },
          async set() {},
        };
      },
    });

    const result = await upsertMeFromAuthClaims({
      sub: "sub-1",
      email: "a@b.com",
      name: "Alice",
    });

    assert.equal(result.created, true);
    assert.equal(result.sub, "sub-1");
  });

  it("updates an existing user doc (created: false)", async () => {
    let getCallCount = 0;

    const dbMock = {
      collection() {
        return {
          doc() {
            return {
              async get() {
                getCallCount++;
                return {
                  exists: true,
                  data() { return { uid: "sub-2", email: "b@c.com" }; },
                };
              },
              async set() {},
            };
          },
        };
      },
    };

    const { upsertMeFromAuthClaims } = loadMeService({
      dbMock,
      deleteMyReviewForCity: async () => {},
    });

    const result = await upsertMeFromAuthClaims({ sub: "sub-2", email: "b@c.com" });

    assert.equal(result.created, false);
    assert.equal(result.sub, "sub-2");
  });

  it("throws 401 when sub is missing", async () => {
    const { upsertMeFromAuthClaims } = loadMeService({
      dbMock: { collection() {} },
      deleteMyReviewForCity: async () => {},
    });

    await assert.rejects(
      () => upsertMeFromAuthClaims({}),
      (err) => { assert.equal(err.status, 401); return true; },
    );
  });
});
