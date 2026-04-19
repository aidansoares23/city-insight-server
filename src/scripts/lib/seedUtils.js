/**
 * Shared seed utilities used by devInit.js and seedMissingReviews.js.
 * Centralised here to avoid duplicating review generation logic across scripts.
 */

const crypto = require("crypto");
const path   = require("path");

// ---------------------------------------------------------------------------
// AI-generated city profiles — loaded at startup, falls back gracefully
// ---------------------------------------------------------------------------

let CITY_PROFILES = {};
try {
  CITY_PROFILES = require(path.join(__dirname, "../data/cityProfiles.json"));
} catch {
  // Not generated yet — generateCityLines.js has not been run.
  // seedUtils will fall back to the hardcoded tables below.
}

// ---------------------------------------------------------------------------
// Seed users — 10 synthetic user accounts used across all seed scripts
// ---------------------------------------------------------------------------

const USERS = [
  { id: "seed-user-001", email: "seed1@example.com",  displayName: "Jordan M." },
  { id: "seed-user-002", email: "seed2@example.com",  displayName: "Priya K."  },
  { id: "seed-user-003", email: "seed3@example.com",  displayName: "Marcus T." },
  { id: "seed-user-004", email: "seed4@example.com",  displayName: "Aisha R."  },
  { id: "seed-user-005", email: "seed5@example.com",  displayName: "Devon L."  },
  { id: "seed-user-006", email: "seed6@example.com",  displayName: "Tanya W."  },
  { id: "seed-user-007", email: "seed7@example.com",  displayName: "Chris H."  },
  { id: "seed-user-008", email: "seed8@example.com",  displayName: "Nadia F."  },
  { id: "seed-user-009", email: "seed9@example.com",  displayName: "Sam O."    },
  { id: "seed-user-010", email: "seed10@example.com", displayName: "Elena V."  },
];

// ---------------------------------------------------------------------------
// City base ratings and review lines
// ---------------------------------------------------------------------------

const CITY_BASE_RATINGS = {
  "san-francisco-ca": { safety: 6, affordability: 2, walkability: 4, cleanliness: 5 },
  "san-jose-ca":      { safety: 7, affordability: 3, walkability: 5, cleanliness: 6 },
  "los-angeles-ca":   { safety: 5, affordability: 2, walkability: 3, cleanliness: 4 },
  "san-diego-ca":     { safety: 6, affordability: 3, walkability: 4, cleanliness: 6 },
  "sacramento-ca":    { safety: 7, affordability: 4, walkability: 3, cleanliness: 6 },
};

const CITY_REVIEW_LINES = {
  "san-francisco-ca": [
    "The neighborhoods have a ton of character and it's easy to stumble into great food and views.",
    "Microclimates are real—bring layers—and the hills are a workout if you walk a lot.",
    "Transit works well in some areas, but the price tag is the hard part to justify.",
  ],
  "san-jose-ca": [
    "It feels clean and practical, but it's more spread out than people expect.",
    "It's a good base for work and the weather is solid, but you'll probably want a car.",
    "Downtown can be hit-or-miss—your neighborhood choice matters a lot.",
  ],
  "los-angeles-ca": [
    "There's an endless amount to do, but traffic dictates your schedule.",
    "Neighborhoods vary wildly, so picking the right area is everything.",
    "Food and culture are top tier, but commuting can wear you down fast.",
  ],
  "san-diego-ca": [
    "The weather and outdoors access make everyday life feel easier.",
    "It's expensive, but the lifestyle payoff is strong if you're into beaches and being outside.",
    "Most areas feel clean and laid back, with pockets that are busier/tourist-heavy.",
  ],
  "sacramento-ca": [
    "It's calmer and more affordable than the Bay, with easier day-to-day living.",
    "Summers get hot, but it's a convenient hub for weekend trips.",
    "Midtown/downtown have gotten more lively with good local spots.",
  ],
};

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Creates the deterministic HMAC-SHA256 review ID for a userId + cityId pair. */
function makeReviewId(userId, cityId) {
  const salt = process.env.REVIEW_ID_SALT;
  if (!salt) throw new Error("Missing REVIEW_ID_SALT in .env");
  return crypto
    .createHmac("sha256", salt)
    .update(`${userId}:${cityId}`)
    .digest("hex")
    .slice(0, 32);
}

/** Splits an array into chunks of at most `size` elements. */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Clamps `n` to [min, max]. */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** Returns `arr[i % arr.length]`, or `null` for an empty/non-array. */
function pick(arr, i) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[i % arr.length];
}

/**
 * Returns the base ratings for a city, preferring AI-generated profiles,
 * then the hardcoded table, then a neutral fallback.
 */
function getCityBaseRatings(cityId) {
  return (
    CITY_PROFILES[cityId]?.baseRatings ||
    CITY_BASE_RATINGS[cityId] ||
    { safety: 6, affordability: 3, walkability: 4, cleanliness: 5 }
  );
}

/**
 * Returns the review lines for a city, preferring AI-generated profiles,
 * then the hardcoded table, then a single generic fallback.
 */
function getCityReviewLines(cityId) {
  return (
    CITY_PROFILES[cityId]?.reviewLines ||
    CITY_REVIEW_LINES[cityId] ||
    ["Overall, it really depends on the specific neighborhood."]
  );
}

/**
 * Generates deterministic but varied ratings for a given city and user index.
 * With 10 users the delta spans {-2, -1, 0, +1, +2} for a realistic spread.
 */
function generateRatings(cityId, userIndex) {
  const base  = getCityBaseRatings(cityId);
  const delta = (userIndex % 5) - 2; // -2, -1, 0, +1, +2
  const safety        = clamp(base.safety        + delta,                         1, 10);
  const affordability = clamp(base.affordability + Math.floor(delta / 2),         1, 10);
  const walkability   = clamp(base.walkability   + (userIndex % 2 === 0 ? 1 : 0), 1, 10);
  const cleanliness   = clamp(base.cleanliness   + (userIndex % 2 === 1 ? 1 : 0), 1, 10);
  const overall       = clamp(Math.round((safety + affordability + walkability + cleanliness) / 4), 1, 10);
  return { safety, affordability, walkability, cleanliness, overall };
}

/** Assembles a natural-language review comment from ratings and city-specific lines. */
function generateComment(cityId, ratings, userIndex) {
  const voices = [
    { tics: ["Honestly,", "Overall,", "In my experience,"] },
    { tics: ["Love it.", "Big fan.", "Genuinely enjoyed it—"] },
    { tics: ["Not gonna lie,", "Be warned:", "If I'm being real,"] },
    { tics: ["Worth noting:", "Quick take:", "My take—"] },
    { tics: ["All things considered,", "To be fair,", "Stepping back,"] },
  ];
  const voice    = voices[userIndex % voices.length];
  const base     = pick(voice.tics, userIndex);
  const lines    = getCityReviewLines(cityId);
  const cityLine = pick(lines, userIndex);

  const safetyNote =
    ratings.safety <= 3 ? "I didn't always feel comfortable at night in certain areas."
    : ratings.safety <= 6 ? "Safety felt okay, but pretty neighborhood-dependent."
    : "I generally felt safe day-to-day.";

  const costNote =
    ratings.affordability <= 3 ? "Costs felt high for what you get."
    : ratings.affordability <= 6 ? "Costs felt manageable with a solid budget."
    : "Cost/value felt pretty solid.";

  const trafficNote =
    ratings.walkability <= 3 ? "Getting around could be frustrating at peak times."
    : ratings.walkability <= 6 ? "Traffic was noticeable, but I could plan around it."
    : "Getting around felt relatively easy most days.";

  const cleanNote =
    ratings.cleanliness <= 3 ? "Cleanliness was a downside in the areas I spent time."
    : ratings.cleanliness <= 6 ? "Cleanliness was mixed depending on where you are."
    : "Most places I went felt clean and well kept.";

  return `${base} ${cityLine} ${safetyNote} ${costNote} ${trafficNote} ${cleanNote}`;
}

module.exports = {
  USERS,
  CITY_PROFILES,
  CITY_BASE_RATINGS,
  CITY_REVIEW_LINES,
  getCityBaseRatings,
  getCityReviewLines,
  makeReviewId,
  chunk,
  clamp,
  pick,
  generateRatings,
  generateComment,
};
