const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function setMock(relPath, exports) {
  const abs = path.resolve(__dirname, "..", relPath);
  const resolved = require.resolve(abs);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function makeCityDoc(id, fields = {}) {
  return {
    id,
    exists: true,
    data() {
      return { slug: id, name: fields.name ?? id, state: fields.state ?? "CA", ...fields };
    },
  };
}

function makeStatsSnap(id, { count = 0, livabilityScore = null } = {}) {
  return {
    exists: count > 0 || livabilityScore !== null,
    data() { return { count, livability: { score: livabilityScore } }; },
  };
}

function makeMetricsSnap(id, { safetyScore = null, medianRent = null } = {}) {
  return {
    exists: safetyScore !== null || medianRent !== null,
    data() { return { safetyScore, medianRent }; },
  };
}

function loadCityService(cityDocs, statsSnaps, metricsSnaps) {
  const adminMock = {
    firestore: {
      FieldPath: { documentId() { return "__name__"; } },
      FieldValue: { serverTimestamp: () => "server-ts" },
    },
  };

  const dbMock = {
    collection(name) {
      if (name === "cities") {
        return {
          orderBy() { return this; },
          async get() { return { docs: cityDocs }; },
          doc(id) {
            const doc = cityDocs.find((d) => d.id === id);
            return {
              _collection: "cities",
              _id: id,
              async get() {
                return doc ?? { exists: false, id, data() { return {}; } };
              },
            };
          },
        };
      }
      // For city_stats and city_metrics, return refs that carry _collection
      // so getAll() can dispatch to the correct snaps array by path rather than call order.
      return {
        doc(id) {
          return { _collection: name, _id: id };
        },
        where() { return this; },
        orderBy() { return this; },
        limit() { return this; },
        async get() { return { docs: [] }; },
      };
    },
    async getAll(...refs) {
      // Dispatch based on the first ref's collection so the result is correct
      // regardless of call order — avoids the fragile call-count alternation.
      const collection = refs[0]?._collection;
      if (collection === "city_stats") {
        return statsSnaps ?? refs.map(() => ({ exists: false, data() { return {}; } }));
      }
      if (collection === "city_metrics") {
        return metricsSnaps ?? refs.map(() => ({ exists: false, data() { return {}; } }));
      }
      return refs.map(() => ({ exists: false, data() { return {}; } }));
    },
  };

  setMock("src/config/firebase.js", { db: dbMock, admin: adminMock });
  setMock("src/utils/timestamps.js", {
    updatedTimestamp: () => ({ updatedAt: "server-ts" }),
  });
  setMock("src/lib/numbers.js", {
    toNumOrNull: (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v)),
    medianRentToAffordability10: () => null,
    normalizeSafetyTo10: (v) => v,
  });
  setMock("src/utils/cityMetrics.js", {
    getCityMetrics: async () => ({
      cityId: "x", medianRent: null, costScore: null,
      population: null, safetyScore: null, crimeIndexPer100k: null, meta: null,
    }),
    upsertCityMetrics: async () => ({}),
  });
  setMock("src/utils/cityStats.js", {
    computeAveragesFromStats: () => ({ count: 0, averages: {} }),
    computeLivabilityV0: () => ({ score: null }),
  });
  setMock("src/lib/firestore.js", {
    tsToIso: () => null,
    buildNextCursorFromDoc: () => null,
    parseCursorFromQuery: () => null,
  });

  const p = require.resolve("../src/services/cityService");
  delete require.cache[p];
  return require("../src/services/cityService");
}

// ─── listCities ───────────────────────────────────────────────────────────────

describe("cityService.listCities — sort modes", () => {
  const cities = [
    makeCityDoc("austin-tx", { name: "Austin", state: "TX" }),
    makeCityDoc("portland-or", { name: "Portland", state: "OR" }),
    makeCityDoc("seattle-wa", { name: "Seattle", state: "WA" }),
  ];
  const statsSnaps = [
    makeStatsSnap("austin-tx", { count: 5, livabilityScore: 60 }),
    makeStatsSnap("portland-or", { count: 10, livabilityScore: 80 }),
    makeStatsSnap("seattle-wa", { count: 3, livabilityScore: 70 }),
  ];
  const metricsSnaps = [
    makeMetricsSnap("austin-tx", { safetyScore: 7, medianRent: 2000 }),
    makeMetricsSnap("portland-or", { safetyScore: 5, medianRent: 1800 }),
    makeMetricsSnap("seattle-wa", { safetyScore: 9, medianRent: 2500 }),
  ];

  it("name_asc returns cities in alphabetical order", async () => {
    const { listCities } = loadCityService(cities, statsSnaps, metricsSnaps);
    const { cities: result } = await listCities({ sort: "name_asc" });
    assert.deepEqual(result.map((c) => c.id), ["austin-tx", "portland-or", "seattle-wa"]);
  });

  it("livability_desc sorts by livability descending with nulls last", async () => {
    const { listCities } = loadCityService(cities, statsSnaps, metricsSnaps);
    const { cities: result } = await listCities({ sort: "livability_desc" });
    assert.equal(result[0].id, "portland-or"); // score 80
    assert.equal(result[1].id, "seattle-wa");  // score 70
    assert.equal(result[2].id, "austin-tx");   // score 60
  });

  it("safety_desc sorts by safetyScore descending", async () => {
    const { listCities } = loadCityService(cities, statsSnaps, metricsSnaps);
    const { cities: result } = await listCities({ sort: "safety_desc" });
    assert.equal(result[0].id, "seattle-wa");  // 9
    assert.equal(result[1].id, "austin-tx");   // 7
    assert.equal(result[2].id, "portland-or"); // 5
  });

  it("rent_asc sorts by medianRent ascending with nulls last", async () => {
    const { listCities } = loadCityService(cities, statsSnaps, metricsSnaps);
    const { cities: result } = await listCities({ sort: "rent_asc" });
    assert.equal(result[0].id, "portland-or"); // 1800
    assert.equal(result[1].id, "austin-tx");   // 2000
    assert.equal(result[2].id, "seattle-wa");  // 2500
  });

  it("reviews_desc sorts by review count descending", async () => {
    const { listCities } = loadCityService(cities, statsSnaps, metricsSnaps);
    const { cities: result } = await listCities({ sort: "reviews_desc" });
    assert.equal(result[0].id, "portland-or"); // 10
    assert.equal(result[1].id, "austin-tx");   // 5
    assert.equal(result[2].id, "seattle-wa");  // 3
  });

  it("q filters cities by name", async () => {
    const { listCities } = loadCityService(cities, statsSnaps, metricsSnaps);
    const { cities: result } = await listCities({ q: "port" });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "portland-or");
  });

  it("limit caps the result set", async () => {
    const { listCities } = loadCityService(cities, statsSnaps, metricsSnaps);
    const { cities: result } = await listCities({ limit: 2 });
    assert.equal(result.length, 2);
  });
});

// ─── getCityBySlug ────────────────────────────────────────────────────────────

describe("cityService.getCityBySlug", () => {
  it("throws 404 when city does not exist", async () => {
    const { getCityBySlug } = loadCityService([], [], []);
    await assert.rejects(
      () => getCityBySlug("nonexistent-xx"),
      (err) => { assert.equal(err.status, 404); assert.equal(err.code, "NOT_FOUND"); return true; },
    );
  });

  it("returns city id and data when found", async () => {
    const cities = [makeCityDoc("portland-or", { name: "Portland" })];
    const { getCityBySlug } = loadCityService(cities, [], []);
    const result = await getCityBySlug("portland-or");
    assert.equal(result.id, "portland-or");
    assert.equal(result.data.name, "Portland");
  });
});
