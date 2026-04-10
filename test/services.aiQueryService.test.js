// test/services.aiQueryService.test.js
// Unit tests for aiQueryService: rankCities (all 7 metrics), filterCities, getCity name matching.
// All Firestore and cityService calls are mocked; no real network or DB needed.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ─── Module injection helpers ─────────────────────────────────────────────────

function setMock(relPath, exports) {
  const abs = path.resolve(__dirname, "..", relPath);
  const resolved = require.resolve(abs);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ─── Shared test city data ────────────────────────────────────────────────────

const ROWS = [
  { id: "portland-or",  name: "Portland",  state: "OR", reviewCount: 10, livabilityScore: 75, safetyScore: 7.5, medianRent: 1800, aqiValue: 30, walkabilityAvg: 8.0, cleanlinessAvg: 7.5, overallAvg: 7.8 },
  { id: "austin-tx",    name: "Austin",    state: "TX", reviewCount: 20, livabilityScore: 65, safetyScore: 6.0, medianRent: 1500, aqiValue: 45, walkabilityAvg: 6.5, cleanlinessAvg: 6.0, overallAvg: 6.5 },
  { id: "seattle-wa",   name: "Seattle",   state: "WA", reviewCount:  5, livabilityScore: 80, safetyScore: 8.0, medianRent: 2200, aqiValue: 25, walkabilityAvg: 8.5, cleanlinessAvg: 8.0, overallAvg: 8.2 },
  { id: "denver-co",    name: "Denver",    state: "CO", reviewCount:  0, livabilityScore: null, safetyScore: null, medianRent: null, aqiValue: null, walkabilityAvg: null, cleanlinessAvg: null, overallAvg: null },
  { id: "portland-me",  name: "Portland",  state: "ME", reviewCount:  3, livabilityScore: 55, safetyScore: 9.0, medianRent: 1200, aqiValue: 20, walkabilityAvg: 7.0, cleanlinessAvg: 7.0, overallAvg: 7.0 },
];

function makeSnap(id, data) {
  return { exists: !!data, id, data() { return data ? { ...data } : {}; } };
}

function loadService() {
  // db mock: collection().doc() returns a ref object; getAll dispatches by _collection.
  const dbMock = {
    collection(name) {
      return {
        doc(id) { return { _collection: name, _id: id }; },
      };
    },
    async getAll(...refs) {
      return refs.map((ref) => {
        const row = ROWS.find((r) => r.id === ref._id);
        if (!row) return makeSnap(ref._id, null);
        if (ref._collection === "cities") {
          return makeSnap(ref._id, { name: row.name, state: row.state, tagline: `${row.name} tagline`, description: null, highlights: [] });
        }
        if (ref._collection === "city_stats") {
          return makeSnap(ref._id, { count: row.reviewCount, livability: { score: row.livabilityScore } });
        }
        if (ref._collection === "city_metrics") {
          return makeSnap(ref._id, { safetyScore: row.safetyScore, medianRent: row.medianRent, population: 600000, aqiValue: row.aqiValue });
        }
        return makeSnap(ref._id, null);
      });
    },
  };

  setMock("src/config/firebase.js", { db: dbMock, admin: {} });
  setMock("src/utils/cityStats.js", {
    computeAveragesFromStats: (doc) => ({
      count: doc?.count ?? 0,
      averages: {
        walkability: doc?.walkabilityAvg ?? null,
        cleanliness: doc?.cleanlinessAvg ?? null,
        overall: doc?.overallAvg ?? null,
      },
    }),
  });
  setMock("src/lib/firestore.js", { tsToIso: () => null });
  setMock("src/services/cityService.js", {
    fetchAllCityRows: async () => ROWS.map((r) => ({ ...r })),
  });

  const resolved = require.resolve("../src/services/aiQueryService");
  delete require.cache[resolved];
  return require("../src/services/aiQueryService");
}

// ─── rankCities ───────────────────────────────────────────────────────────────

describe("aiQueryService.rankCities — livabilityScore", () => {
  it("ranks by livabilityScore descending, nulls last", async () => {
    const { rankCities } = loadService();
    const { cities } = await rankCities("livabilityScore", 5);
    assert.equal(cities[0].slug, "seattle-wa");   // 80
    assert.equal(cities[1].slug, "portland-or");  // 75
    assert.equal(cities[2].slug, "austin-tx");    // 65
    assert.equal(cities[3].slug, "portland-me");  // 55
    // denver-co has null — sorts last
    assert.equal(cities[4].slug, "denver-co");
  });

  it("assigns rank field starting at 1", async () => {
    const { rankCities } = loadService();
    const { cities } = await rankCities("livabilityScore", 3);
    assert.deepEqual(cities.map((c) => c.rank), [1, 2, 3]);
  });
});

describe("aiQueryService.rankCities — safetyScore", () => {
  it("ranks by safetyScore descending, nulls last", async () => {
    const { rankCities } = loadService();
    const { cities } = await rankCities("safetyScore", 3);
    assert.equal(cities[0].slug, "portland-me");  // 9.0
    assert.equal(cities[1].slug, "seattle-wa");   // 8.0
    assert.equal(cities[2].slug, "portland-or");  // 7.5
  });
});

describe("aiQueryService.rankCities — affordability (medianRent)", () => {
  it("ranks by medianRent ascending (cheapest first), nulls last", async () => {
    const { rankCities } = loadService();
    const { cities } = await rankCities("affordability", 4);
    assert.equal(cities[0].slug, "portland-me");  // 1200
    assert.equal(cities[1].slug, "austin-tx");    // 1500
    assert.equal(cities[2].slug, "portland-or");  // 1800
    assert.equal(cities[3].slug, "seattle-wa");   // 2200
  });
});

describe("aiQueryService.rankCities — reviewCount", () => {
  it("ranks by reviewCount descending", async () => {
    const { rankCities } = loadService();
    const { cities } = await rankCities("reviewCount", 3);
    assert.equal(cities[0].slug, "austin-tx");    // 20
    assert.equal(cities[1].slug, "portland-or");  // 10
    assert.equal(cities[2].slug, "seattle-wa");   // 5
  });
});

describe("aiQueryService.rankCities — walkabilityAvg", () => {
  it("ranks by walkabilityAvg descending, skips cities with 0 reviews", async () => {
    const { rankCities } = loadService();
    const { cities } = await rankCities("walkabilityAvg", 5);
    assert.equal(cities[0].slug, "seattle-wa");   // 8.5
    assert.equal(cities[1].slug, "portland-or");  // 8.0
    // denver-co has 0 reviews — walkabilityAvg is null → goes last
    const denverEntry = cities.find((c) => c.slug === "denver-co");
    assert.ok(!denverEntry || denverEntry.rank > cities.length - 1);
  });
});

describe("aiQueryService.rankCities — cleanlinessAvg", () => {
  it("ranks by cleanlinessAvg descending", async () => {
    const { rankCities } = loadService();
    const { cities } = await rankCities("cleanlinessAvg", 3);
    assert.equal(cities[0].slug, "seattle-wa");  // 8.0
  });
});

describe("aiQueryService.rankCities — overallAvg", () => {
  it("ranks by overallAvg descending", async () => {
    const { rankCities } = loadService();
    const { cities } = await rankCities("overallAvg", 3);
    assert.equal(cities[0].slug, "seattle-wa");  // 8.2
  });
});

describe("aiQueryService.rankCities — state filter", () => {
  it("returns only cities matching the given state", async () => {
    const { rankCities } = loadService();
    const { cities } = await rankCities("livabilityScore", 5, "OR");
    assert.equal(cities.length, 1);
    assert.equal(cities[0].slug, "portland-or");
  });

  it("returns empty list when no cities match the state", async () => {
    const { rankCities } = loadService();
    const { cities } = await rankCities("livabilityScore", 5, "AK");
    assert.equal(cities.length, 0);
  });
});

describe("aiQueryService.rankCities — invalid metric", () => {
  it("returns an error object for unknown metric", async () => {
    const { rankCities } = loadService();
    const result = await rankCities("bogusMetric");
    assert.ok("error" in result);
  });
});

// ─── filterCities ─────────────────────────────────────────────────────────────

describe("aiQueryService.filterCities — threshold filters", () => {
  it("minSafetyScore filters out cities below threshold", async () => {
    const { filterCities } = loadService();
    const { cities } = await filterCities({ minSafetyScore: 8.0 });
    const slugs = cities.map((c) => c.slug);
    assert.ok(slugs.includes("seattle-wa"));    // 8.0
    assert.ok(slugs.includes("portland-me"));   // 9.0
    assert.ok(!slugs.includes("austin-tx"));    // 6.0
    assert.ok(!slugs.includes("denver-co"));    // null
  });

  it("maxMedianRent filters out expensive cities", async () => {
    const { filterCities } = loadService();
    const { cities } = await filterCities({ maxMedianRent: 1800 });
    const slugs = cities.map((c) => c.slug);
    assert.ok(slugs.includes("portland-me"));   // 1200
    assert.ok(slugs.includes("austin-tx"));     // 1500
    assert.ok(slugs.includes("portland-or"));   // 1800
    assert.ok(!slugs.includes("seattle-wa"));   // 2200
    assert.ok(!slugs.includes("denver-co"));    // null
  });

  it("minLivabilityScore filters correctly", async () => {
    const { filterCities } = loadService();
    const { cities } = await filterCities({ minLivabilityScore: 70 });
    const slugs = cities.map((c) => c.slug);
    assert.ok(slugs.includes("seattle-wa"));    // 80
    assert.ok(slugs.includes("portland-or"));   // 75
    assert.ok(!slugs.includes("austin-tx"));    // 65
  });

  it("state filter narrows results", async () => {
    const { filterCities } = loadService();
    const { cities } = await filterCities({ state: "TX" });
    assert.equal(cities.length, 1);
    assert.equal(cities[0].slug, "austin-tx");
  });

  it("combined filters apply all constraints", async () => {
    const { filterCities } = loadService();
    const { cities } = await filterCities({ minSafetyScore: 7.0, maxMedianRent: 2000 });
    const slugs = cities.map((c) => c.slug);
    assert.ok(slugs.includes("portland-or"));   // safety 7.5, rent 1800 ✓
    assert.ok(slugs.includes("portland-me"));   // safety 9.0, rent 1200 ✓
    assert.ok(!slugs.includes("seattle-wa"));   // safety 8.0 ✓, but rent 2200 ✗
    assert.ok(!slugs.includes("austin-tx"));    // safety 6.0 ✗
  });

  it("results are sorted by livabilityScore descending", async () => {
    const { filterCities } = loadService();
    const { cities } = await filterCities({ minSafetyScore: 6.0 });
    const scores = cities.map((c) => c.livabilityScore).filter((s) => s != null);
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i - 1] >= scores[i], "results should be sorted by livability descending");
    }
  });

  it("limit caps the result set", async () => {
    const { filterCities } = loadService();
    const { cities } = await filterCities({ limit: 2 });
    assert.equal(cities.length, 2);
  });

  it("returns empty list when no cities match filters", async () => {
    const { filterCities } = loadService();
    const { cities } = await filterCities({ minSafetyScore: 100 });
    assert.equal(cities.length, 0);
  });
});

// ─── getCity — name matching ──────────────────────────────────────────────────

describe("aiQueryService.getCity — name matching", () => {
  it("finds a city by exact name", async () => {
    const { getCity } = loadService();
    const result = await getCity("Austin");
    assert.equal(result.found, true);
    assert.equal(result.cities[0].slug, "austin-tx");
  });

  it("finds a city by case-insensitive name", async () => {
    const { getCity } = loadService();
    const result = await getCity("SEATTLE");
    assert.equal(result.found, true);
    assert.equal(result.cities[0].slug, "seattle-wa");
  });

  it("finds a city by city, state format", async () => {
    const { getCity } = loadService();
    const result = await getCity("Portland, OR");
    assert.equal(result.found, true);
    assert.equal(result.cities[0].slug, "portland-or");
  });

  it("returns found: false when no city matches", async () => {
    const { getCity } = loadService();
    const result = await getCity("Atlantis");
    assert.equal(result.found, false);
    assert.equal(result.cities.length, 0);
  });

  it("returns at most 3 matches for ambiguous name", async () => {
    const { getCity } = loadService();
    // "Portland" matches portland-or and portland-me
    const result = await getCity("Portland");
    assert.equal(result.found, true);
    assert.ok(result.cities.length <= 3);
    const slugs = result.cities.map((c) => c.slug);
    assert.ok(slugs.includes("portland-or") || slugs.includes("portland-me"));
  });

  it("result cities include expected fields", async () => {
    const { getCity } = loadService();
    const result = await getCity("Seattle");
    const city = result.cities[0];
    assert.ok("slug" in city);
    assert.ok("name" in city);
    assert.ok("state" in city);
    assert.ok("stats" in city);
    assert.ok("metrics" in city);
  });
});
