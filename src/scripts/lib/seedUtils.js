/**
 * Shared seed utilities used by devInit.js and seedMissingReviews.js.
 * Centralised here to avoid duplicating review generation logic across scripts.
 */

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Seed users — the same 5 synthetic user accounts used in all seed scripts
// ---------------------------------------------------------------------------

const USERS = [
  { id: "seed-user-001", email: "seed1@example.com", displayName: "Seed User 1" },
  { id: "seed-user-002", email: "seed2@example.com", displayName: "Seed User 2" },
  { id: "seed-user-003", email: "seed3@example.com", displayName: "Seed User 3" },
  { id: "seed-user-004", email: "seed4@example.com", displayName: "Seed User 4" },
  { id: "seed-user-005", email: "seed5@example.com", displayName: "Seed User 5" },
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
 * Generates deterministic but varied ratings for a given city and user index.
 * Unknown cityIds fall back to a neutral set.
 */
function generateRatings(cityId, userIndex) {
  const base = CITY_BASE_RATINGS[cityId] || { safety: 6, affordability: 3, walkability: 4, cleanliness: 5 };
  const delta = (userIndex % 3) - 1; // -1, 0, +1
  const safety        = clamp(base.safety        + delta,                          1, 10);
  const affordability = clamp(base.affordability + (delta === 1 ? 0 : -1),         1, 10);
  const walkability   = clamp(base.walkability   + (userIndex % 2 === 0 ? 1 : 0),  1, 10);
  const cleanliness   = clamp(base.cleanliness   + (userIndex % 2 === 1 ? 1 : 0),  1, 10);
  const overall       = clamp(Math.round((safety + affordability + walkability + cleanliness) / 4), 1, 10);
  return { safety, affordability, walkability, cleanliness, overall };
}

/** Assembles a natural-language review comment from ratings and city-specific lines. */
function generateComment(cityId, ratings, userIndex) {
  const voices = [
    { tics: ["Honestly,", "Overall,", "In my experience,"] },
    { tics: ["Love it.", "Big fan.", "Genuinely enjoyed it—"] },
    { tics: ["Not gonna lie,", "Be warned:", "If I'm being real,"] },
  ];
  const voice = voices[userIndex % voices.length];
  const base = pick(voice.tics, userIndex);
  const lines = CITY_REVIEW_LINES[cityId] || ["Overall, it depends a lot on the neighborhood."];
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
  CITY_BASE_RATINGS,
  CITY_REVIEW_LINES,
  makeReviewId,
  chunk,
  clamp,
  pick,
  generateRatings,
  generateComment,
};
