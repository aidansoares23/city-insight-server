const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function setMock(relPath, exports) {
  const abs = path.resolve(__dirname, "..", relPath);
  const resolved = require.resolve(abs);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function loadCityMetrics(dbMock) {
  const adminMock = {
    firestore: {
      FieldValue: { serverTimestamp: () => "__server_ts__" },
    },
  };

  setMock("src/config/firebase.js", { db: dbMock, admin: adminMock });
  setMock("src/utils/timestamps.js", {
    updatedTimestamp: () => ({ updatedAt: "__server_ts__" }),
  });
  setMock("src/lib/numbers.js", {
    toNumOrNull: (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v)),
    medianRentToAffordability10: (rent) => (rent == null ? null : 10 - rent / 500),
    normalizeSafetyTo10: (v) => (v == null ? null : Number(v)),
  });
  setMock("src/lib/objects.js", {
    isPlainObject: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  });
  setMock("src/lib/meta.js", {
    buildNamespacedMetaUpdate: () => null,
  });

  const p = require.resolve("../src/utils/cityMetrics");
  delete require.cache[p];
  return require("../src/utils/cityMetrics");
}

// ─── getCityMetrics ───────────────────────────────────────────────────────────

describe("getCityMetrics", () => {
  it("returns null-filled object when doc does not exist", async () => {
    const dbMock = {
      collection() {
        return {
          doc() { return { async get() { return { exists: false }; } }; },
        };
      },
    };

    const { getCityMetrics } = loadCityMetrics(dbMock);
    const result = await getCityMetrics("portland-or");

    assert.equal(result.cityId, "portland-or");
    assert.equal(result.medianRent, null);
    assert.equal(result.safetyScore, null);
    assert.equal(result.population, null);
    assert.equal(result.crimeIndexPer100k, null);
    assert.equal(result.costScore, null);
    assert.equal(result.meta, null);
  });

  it("normalizes and returns data from existing doc", async () => {
    const dbMock = {
      collection() {
        return {
          doc() {
            return {
              async get() {
                return {
                  exists: true,
                  data() {
                    return {
                      medianRent: 2000,
                      population: 650000,
                      safetyScore: 7,
                      crimeIndexPer100k: 1200,
                    };
                  },
                };
              },
            };
          },
        };
      },
    };

    const { getCityMetrics } = loadCityMetrics(dbMock);
    const result = await getCityMetrics("portland-or");

    assert.equal(result.medianRent, 2000);
    assert.equal(result.population, 650000);
    assert.equal(result.safetyScore, 7);
    assert.equal(result.crimeIndexPer100k, 1200);
    assert.ok(result.costScore !== undefined);
  });
});

// ─── upsertCityMetrics ────────────────────────────────────────────────────────

describe("upsertCityMetrics", () => {
  it("writes all provided fields without an owner", async () => {
    const written = [];
    const dbMock = {
      collection() {
        return {
          doc() {
            return {
              async set(data) { written.push(data); },
            };
          },
        };
      },
    };

    const { upsertCityMetrics } = loadCityMetrics(dbMock);
    await upsertCityMetrics("portland-or", { medianRent: 2000, population: 650000 });

    assert.equal(written.length, 1);
    assert.equal(written[0].medianRent, 2000);
    assert.equal(written[0].population, 650000);
    assert.equal(written[0].cityId, "portland-or");
  });

  it("null-guards: skips null field when existing value is non-null (owner mode)", async () => {
    const written = [];
    const dbMock = {
      collection() {
        return {
          doc() {
            return {
              async get() {
                return {
                  exists: true,
                  data() { return { medianRent: 1800, population: 600000 }; },
                };
              },
              async set(data) { written.push({ ...data }); },
              collection() { return { async add() {} }; },
            };
          },
        };
      },
    };

    const { upsertCityMetrics } = loadCityMetrics(dbMock);
    // medianRent is owned by metricsSync; passing null should NOT overwrite existing 1800
    await upsertCityMetrics("portland-or", { medianRent: null, population: 700000 }, { owner: "metricsSync" });

    assert.equal(written.length, 1);
    // medianRent should NOT be written (null-guarded)
    assert.ok(!Object.prototype.hasOwnProperty.call(written[0], "medianRent"));
    // population should be written
    assert.equal(written[0].population, 700000);
  });

  it("records a snapshot with serverTimestamp when values change (owner mode)", async () => {
    const snapshots = [];
    const dbMock = {
      collection() {
        return {
          doc() {
            return {
              async get() {
                return { exists: true, data() { return { medianRent: 1800 }; } };
              },
              async set() {},
              collection(subName) {
                return {
                  async add(data) { snapshots.push(data); },
                };
              },
            };
          },
        };
      },
    };

    const { upsertCityMetrics } = loadCityMetrics(dbMock);
    await upsertCityMetrics("portland-or", { medianRent: 2000 }, { owner: "metricsSync" });

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].pipeline, "metricsSync");
    // serverTimestamp sentinel (not a real Date string)
    assert.equal(snapshots[0].syncedAt, "__server_ts__");
    assert.equal(snapshots[0].changed, true);
    assert.equal(snapshots[0].newValues.medianRent, 2000);
    assert.equal(snapshots[0].prevValues.medianRent, 1800);
  });
});
