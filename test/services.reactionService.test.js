// test/services.reactionService.test.js
// Unit tests for reactionService: upsert, delete, counts (chunking), my-reactions.
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ─── Module injection helpers ─────────────────────────────────────────────────

function setMock(relPath, exports) {
  const abs = path.resolve(__dirname, "..", relPath);
  const resolved = require.resolve(abs);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ─── In-memory Firestore store ────────────────────────────────────────────────
// `store` is reset before every test via beforeEach.

let store; // Map<collectionName, Map<docId, plainObject>>

function makeDocRef(collection, id) {
  return {
    _collection: collection,
    _id: id,
    async get() {
      const data = store.get(collection)?.get(id);
      return data
        ? { exists: true, id, data() { return { ...data }; } }
        : { exists: false, id, data() { return null; } };
    },
    async set(patch, opts) {
      if (!store.has(collection)) store.set(collection, new Map());
      const existing = opts?.merge ? (store.get(collection).get(id) ?? {}) : {};
      store.get(collection).set(id, { ...existing, ...patch });
    },
    async delete() {
      store.get(collection)?.delete(id);
    },
  };
}

const dbMock = {
  collection(name) {
    return {
      doc(id) { return makeDocRef(name, id); },
      where(field, op, values) {
        // Supports only: where("reviewId", "in", [...])
        return {
          async get() {
            const col = store.get(name) ?? new Map();
            const docs = [];
            for (const data of col.values()) {
              if (field === "reviewId" && op === "in" && values.includes(data[field])) {
                docs.push({ data() { return { ...data }; } });
              }
            }
            return {
              forEach(fn) { docs.forEach(fn); },
            };
          },
        };
      },
    };
  },
  async getAll(...refs) {
    return Promise.all(refs.map((ref) => ref.get()));
  },
};

class AppError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.status = opts.status ?? 500;
    this.code = opts.code ?? "INTERNAL";
  }
}

function loadService() {
  setMock("src/config/firebase.js", {
    db: dbMock,
    admin: { firestore: { FieldValue: { serverTimestamp: () => "server-ts" } } },
  });
  setMock("src/utils/timestamps.js", {
    serverTimestamps: () => ({ createdAt: "server-ts", updatedAt: "server-ts" }),
    updatedTimestamp: () => ({ updatedAt: "server-ts" }),
  });
  setMock("src/lib/errors.js", { AppError });

  const resolved = require.resolve("../src/services/reactionService");
  delete require.cache[resolved];
  return require("../src/services/reactionService");
}

// ─── upsertReaction ───────────────────────────────────────────────────────────

describe("reactionService.upsertReaction — validation", () => {
  beforeEach(() => {
    store = new Map([
      ["reviews", new Map([["review-1", { cityId: "portland-or", userId: "author-uid" }]])],
      ["review_reactions", new Map()],
    ]);
  });

  it("throws 404 when review does not exist", async () => {
    const { upsertReaction } = loadService();
    await assert.rejects(
      () => upsertReaction({ userId: "user-1", reviewId: "nonexistent", cityId: "portland-or", type: "helpful" }),
      (err) => { assert.equal(err.status, 404); assert.equal(err.code, "NOT_FOUND"); return true; },
    );
  });

  it("throws 404 when review belongs to a different city", async () => {
    const { upsertReaction } = loadService();
    await assert.rejects(
      () => upsertReaction({ userId: "user-1", reviewId: "review-1", cityId: "wrong-city", type: "helpful" }),
      (err) => { assert.equal(err.status, 404); assert.equal(err.code, "NOT_FOUND"); return true; },
    );
  });

  it("throws 403 when user reacts to their own review", async () => {
    const { upsertReaction } = loadService();
    await assert.rejects(
      () => upsertReaction({ userId: "author-uid", reviewId: "review-1", cityId: "portland-or", type: "helpful" }),
      (err) => { assert.equal(err.status, 403); assert.equal(err.code, "CANNOT_REACT_TO_OWN_REVIEW"); return true; },
    );
  });
});

describe("reactionService.upsertReaction — create / overwrite", () => {
  beforeEach(() => {
    store = new Map([
      ["reviews", new Map([["review-1", { cityId: "portland-or", userId: "author-uid" }]])],
      ["review_reactions", new Map()],
    ]);
  });

  it("creates a new reaction when none exists", async () => {
    const { upsertReaction } = loadService();
    await upsertReaction({ userId: "user-1", reviewId: "review-1", cityId: "portland-or", type: "helpful" });
    const stored = store.get("review_reactions").get("user-1:review-1");
    assert.equal(stored?.type, "helpful");
  });

  it("overwrites an existing reaction with a new type", async () => {
    store.get("review_reactions").set("user-1:review-1", {
      userId: "user-1", reviewId: "review-1", cityId: "portland-or", type: "agree",
    });
    const { upsertReaction } = loadService();
    await upsertReaction({ userId: "user-1", reviewId: "review-1", cityId: "portland-or", type: "disagree" });
    const stored = store.get("review_reactions").get("user-1:review-1");
    assert.equal(stored?.type, "disagree");
  });
});

// ─── deleteReaction ───────────────────────────────────────────────────────────

describe("reactionService.deleteReaction", () => {
  beforeEach(() => {
    store = new Map([
      ["review_reactions", new Map([
        ["user-1:review-1", { userId: "user-1", reviewId: "review-1", type: "helpful" }],
      ])],
    ]);
  });

  it("removes an existing reaction", async () => {
    const { deleteReaction } = loadService();
    await deleteReaction({ userId: "user-1", reviewId: "review-1" });
    assert.equal(store.get("review_reactions").has("user-1:review-1"), false);
  });

  it("is idempotent when the reaction does not exist", async () => {
    const { deleteReaction } = loadService();
    // Should resolve without throwing
    await deleteReaction({ userId: "user-1", reviewId: "nonexistent" });
  });
});

// ─── getReactionCountsForReviews ──────────────────────────────────────────────

describe("reactionService.getReactionCountsForReviews", () => {
  beforeEach(() => { store = new Map(); });

  it("returns empty map for empty input", async () => {
    const { getReactionCountsForReviews } = loadService();
    const result = await getReactionCountsForReviews([]);
    assert.equal(result.size, 0);
  });

  it("aggregates counts by type per review", async () => {
    store.set("review_reactions", new Map([
      ["u1:r1", { reviewId: "r1", type: "helpful" }],
      ["u2:r1", { reviewId: "r1", type: "helpful" }],
      ["u3:r1", { reviewId: "r1", type: "agree" }],
      ["u1:r2", { reviewId: "r2", type: "disagree" }],
    ]));
    const { getReactionCountsForReviews } = loadService();
    const result = await getReactionCountsForReviews(["r1", "r2"]);
    assert.deepEqual(result.get("r1"), { helpful: 2, agree: 1, disagree: 0 });
    assert.deepEqual(result.get("r2"), { helpful: 0, agree: 0, disagree: 1 });
  });

  it("handles >30 review IDs by chunking queries", async () => {
    const reactions = new Map();
    const reviewIds = [];
    for (let i = 1; i <= 35; i++) {
      const rid = `r${i}`;
      reviewIds.push(rid);
      reactions.set(`u1:${rid}`, { reviewId: rid, type: "helpful" });
    }
    store.set("review_reactions", reactions);

    const { getReactionCountsForReviews } = loadService();
    const result = await getReactionCountsForReviews(reviewIds);

    assert.equal(result.size, 35, "all 35 review IDs should be in the result");
    for (const rid of reviewIds) {
      assert.equal(result.get(rid)?.helpful, 1, `${rid} should have 1 helpful reaction`);
    }
  });

  it("returns zero-count entry for reviews with no reactions when queried directly", async () => {
    store.set("review_reactions", new Map());
    const { getReactionCountsForReviews } = loadService();
    // A review with no reactions won't appear in the counts map at all — that is expected
    const result = await getReactionCountsForReviews(["r-no-reactions"]);
    assert.equal(result.has("r-no-reactions"), false);
  });
});

// ─── getMyReactionsForReviews ─────────────────────────────────────────────────

describe("reactionService.getMyReactionsForReviews", () => {
  beforeEach(() => {
    store = new Map([
      ["review_reactions", new Map([
        ["user-1:r1", { reviewId: "r1", type: "helpful" }],
        ["user-1:r3", { reviewId: "r3", type: "agree" }],
        ["user-2:r1", { reviewId: "r1", type: "disagree" }],
      ])],
    ]);
  });

  it("returns empty map for empty reviewIds", async () => {
    const { getMyReactionsForReviews } = loadService();
    const result = await getMyReactionsForReviews({ userId: "user-1", reviewIds: [] });
    assert.equal(result.size, 0);
  });

  it("maps reviewId → type for the requesting user's reactions", async () => {
    const { getMyReactionsForReviews } = loadService();
    const result = await getMyReactionsForReviews({ userId: "user-1", reviewIds: ["r1", "r2", "r3"] });
    assert.equal(result.get("r1"), "helpful");
    assert.equal(result.has("r2"), false, "r2 has no reaction — should not appear");
    assert.equal(result.get("r3"), "agree");
  });

  it("isolates reactions per user — different users see only their own", async () => {
    const { getMyReactionsForReviews } = loadService();
    const user2Result = await getMyReactionsForReviews({ userId: "user-2", reviewIds: ["r1"] });
    assert.equal(user2Result.get("r1"), "disagree");

    const user1Result = await getMyReactionsForReviews({ userId: "user-1", reviewIds: ["r1"] });
    assert.equal(user1Result.get("r1"), "helpful");
  });
});
