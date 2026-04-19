/**
 * Fetches nearby places using the OpenStreetMap Overpass API.
 * No API key required — free public service.
 * Exported as foursquareService for backward compatibility with attractions.js.
 *
 * Uses a single combined query per city to minimize API calls.
 * Includes retry logic with exponential backoff for 429/504 responses.
 */

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const RADIUS_METERS = 10000;       // 10 km — smaller radius = lighter queries, fewer timeouts
const RESULTS_PER_CATEGORY = 5;
const TOTAL_FETCH_LIMIT = 30;      // enough to fill all 4 buckets without overloading the server

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000]; // 15s, 30s, 60s

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Regex tests used to bucket raw OSM elements into category buckets after fetching
const CATEGORY_MATCHERS = [
  {
    key: "restaurants",
    test: (tags) => /^(restaurant|cafe|bakery|food_court|ice_cream)$/.test(tags.amenity ?? ""),
  },
  {
    key: "nightlife",
    test: (tags) => /^(bar|nightclub|pub|casino|theatre|cinema)$/.test(tags.amenity ?? ""),
  },
  {
    key: "attractions",
    test: (tags) =>
      /^(museum|attraction|gallery|viewpoint|zoo|aquarium|theme_park|artwork)$/.test(tags.tourism ?? "") ||
      /^(monument|memorial|castle|ruins|archaeological_site|landmark)$/.test(tags.historic ?? ""),
  },
  {
    key: "outdoors",
    test: (tags) =>
      /^(park|nature_reserve|garden|beach_resort|golf_course|stadium)$/.test(tags.leisure ?? "") ||
      /^(beach|cliff|peak|spring|waterfall)$/.test(tags.natural ?? ""),
  },
];

const CATEGORY_LABELS = {
  attractions: "Attraction",
  restaurants: "Restaurant",
  outdoors:    "Outdoors",
  nightlife:   "Nightlife",
};

function classifyElement(el) {
  const tags = el.tags || {};
  for (const { key, test } of CATEGORY_MATCHERS) {
    if (test(tags)) return key;
  }
  return null;
}

function humanizeTag(value) {
  if (!value) return null;
  const first = String(value).split(";")[0].trim();
  return first.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeOsmPlace(el, categoryKey) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat ?? null;
  const lng = el.lon ?? el.center?.lon ?? null;

  const street = tags["addr:street"] ?? null;
  const num    = tags["addr:housenumber"] ?? null;
  const city   = tags["addr:city"] ?? null;
  const addrParts = [num && street ? `${num} ${street}` : street, city].filter(Boolean);
  const address = addrParts.length > 0 ? addrParts.join(", ") : null;

  const rawLabel =
    humanizeTag(tags.cuisine)  ||
    humanizeTag(tags.tourism)  ||
    humanizeTag(tags.historic) ||
    humanizeTag(tags.leisure)  ||
    humanizeTag(tags.natural)  ||
    humanizeTag(tags.amenity)  ||
    CATEGORY_LABELS[categoryKey];

  return {
    fsqId:      `osm_${el.type}_${el.id}`,
    name:       tags.name ?? null,
    address,
    lat,
    lng,
    rating:     null,
    priceLevel: null,
    photoUrl:   null,
    categories: rawLabel ? [rawLabel] : [],
    website:    tags.website ?? tags["contact:website"] ?? null,
    distance:   null,
  };
}

/**
 * Builds a single combined Overpass QL query covering all 4 category buckets.
 * Restaurants and nightlife use node-only (they're rarely mapped as ways).
 * Attractions and outdoors use both node and way (parks, landmarks often are ways).
 */
function buildCombinedQuery(lat, lng, limit) {
  const ar = `(around:${RADIUS_METERS},${lat},${lng})`;

  const parts = [
    // Attractions
    `node["tourism"~"museum|attraction|gallery|viewpoint|zoo|aquarium|theme_park|artwork"]${ar}["name"];`,
    `way["tourism"~"museum|attraction|gallery|viewpoint|zoo|aquarium|theme_park"]${ar}["name"];`,
    `node["historic"~"monument|memorial|castle|ruins|landmark"]${ar}["name"];`,
    `way["historic"~"monument|memorial|castle|ruins|landmark"]${ar}["name"];`,
    // Restaurants (nodes only)
    `node["amenity"~"restaurant|cafe|bakery|food_court|ice_cream"]${ar}["name"];`,
    // Outdoors
    `node["leisure"~"park|nature_reserve|garden|golf_course"]${ar}["name"];`,
    `way["leisure"~"park|nature_reserve|garden"]${ar}["name"];`,
    `node["natural"~"beach|peak|waterfall"]${ar}["name"];`,
    `way["natural"~"beach"]${ar}["name"];`,
    // Nightlife (nodes only)
    `node["amenity"~"bar|nightclub|pub|casino|theatre|cinema"]${ar}["name"];`,
  ];

  return `[out:json][timeout:25];\n(\n  ${parts.join("\n  ")}\n);\nout center ${limit};`;
}

/**
 * Fetches all four category buckets for a city in a single Overpass API request.
 * Retries up to MAX_RETRIES times on 429 or 504, with increasing delays.
 * @param {number} lat
 * @param {number} lng
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ attractions: Array, restaurants: Array, outdoors: Array, nightlife: Array }>}
 */
async function fetchAllCategoryPlaces(lat, lng, { limit = RESULTS_PER_CATEGORY } = {}) {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is unavailable. Use Node.js 18+.");
  }

  const query = buildCombinedQuery(lat, lng, TOTAL_FETCH_LIMIT);
  const body  = new URLSearchParams({ data: query }).toString();

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      console.log(`[attractions] retry ${attempt}/${MAX_RETRIES} in ${wait / 1000}s…`);
      await sleep(wait);
    }

    const res = await globalThis.fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (res.status === 429 || res.status === 504) {
      lastErr = new Error(`Overpass API failed: HTTP ${res.status}`);
      continue; // retry
    }

    if (!res.ok) {
      throw new Error(`Overpass API failed: HTTP ${res.status}`);
    }

    const data     = await res.json();
    const elements = data.elements ?? [];

    const buckets = { attractions: [], restaurants: [], outdoors: [], nightlife: [] };
    for (const el of elements) {
      const key = classifyElement(el);
      if (!key || buckets[key].length >= limit) continue;
      buckets[key].push(normalizeOsmPlace(el, key));
    }

    return buckets;
  }

  throw lastErr ?? new Error("Overpass API failed after retries");
}

module.exports = { fetchAllCategoryPlaces };
