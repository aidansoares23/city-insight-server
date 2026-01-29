// src/scripts/devInit.js
// Run: node src/scripts/devInit.js
//
// Flags:
//   --wipeAllReviews         Danger: deletes ALL reviews
//   --wipeSeededReviews      Deletes only reviews by seed users (safer)
//   --skipMetrics            Don't write manual metrics
//
// What it does:
// 1) Upserts cities/{slug} and RESETS city_stats/{slug} to minimal shape
// 2) Seeds users + reviews (deterministic review IDs)
// 3) Optionally syncs manual city_metrics
// 4) Recomputes city_stats from reviews for all seeded cities (also recomputes livability)

const crypto = require("crypto");
const { initAdmin } = require("./lib/initAdmin");
initAdmin();

// IMPORTANT: import after initAdmin so your config/firebase can reuse the existing admin app
const { admin, db } = require("../config/firebase");
const { recomputeCityStatsFromReviews } = require("../utils/cityStats");

function hasFlag(name) {
  return process.argv.includes(name);
}

const WIPE_ALL_REVIEWS = hasFlag("--wipeAllReviews");
const WIPE_SEEDED_REVIEWS = hasFlag("--wipeSeededReviews");
const SKIP_METRICS = hasFlag("--skipMetrics");

if (WIPE_ALL_REVIEWS && WIPE_SEEDED_REVIEWS) {
  console.error("Use either --wipeAllReviews OR --wipeSeededReviews, not both.");
  process.exit(1);
}

// --------------------
// Seed data
// --------------------
const CITIES = [
  { slug: "san-francisco-ca", name: "San Francisco", state: "CA", lat: 37.7749, lng: -122.4194 },
  { slug: "san-jose-ca", name: "San Jose", state: "CA", lat: 37.3382, lng: -121.8863 },
  { slug: "los-angeles-ca", name: "Los Angeles", state: "CA", lat: 34.0522, lng: -118.2437 },
  { slug: "san-diego-ca", name: "San Diego", state: "CA", lat: 32.7157, lng: -117.1611 },
  { slug: "sacramento-ca", name: "Sacramento", state: "CA", lat: 38.5816, lng: -121.4944 },
];

const USERS = [
  { id: "seed-user-001", email: "seed1@example.com", displayName: "Seed User 1" },
  { id: "seed-user-002", email: "seed2@example.com", displayName: "Seed User 2" },
  { id: "seed-user-003", email: "seed3@example.com", displayName: "Seed User 3" },
  { id: "seed-user-004", email: "seed4@example.com", displayName: "Seed User 4" },
  { id: "seed-user-005", email: "seed5@example.com", displayName: "Seed User 5" },
];

const CITY_IDS = CITIES.map((c) => c.slug);

// Manual dev metrics (swap for real providers later)
const METRICS = {
  "san-francisco-ca": { medianRent: 3400, population: 808988, safetyScore: null },
  "san-jose-ca":      { medianRent: 2900, population: 971233, safetyScore: null },
  "los-angeles-ca":   { medianRent: 2500, population: 3820914, safetyScore: null },
  "san-diego-ca":     { medianRent: 2700, population: 1386932, safetyScore: null },
  "sacramento-ca":    { medianRent: 1900, population: 526384, safetyScore: null },
};

// --------------------
// Helpers
// --------------------

function makeReviewId(userId, cityId) {
  const salt = process.env.REVIEW_ID_SALT;
  if (!salt) throw new Error("Missing REVIEW_ID_SALT in .env");
  return crypto
    .createHash("sha256")
    .update(`${userId}:${cityId}:${salt}`)
    .digest("hex")
    .slice(0, 32);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function generateRatings(cityIndex, userIndex) {
  const cityBase =
    [
      { safety: 6, cost: 2, traffic: 4, cleanliness: 5 }, // SF
      { safety: 7, cost: 3, traffic: 5, cleanliness: 6 }, // SJ
      { safety: 5, cost: 2, traffic: 3, cleanliness: 4 }, // LA
      { safety: 6, cost: 3, traffic: 4, cleanliness: 6 }, // SD
      { safety: 7, cost: 4, traffic: 3, cleanliness: 6 }, // SAC
    ][cityIndex] || { safety: 6, cost: 3, traffic: 4, cleanliness: 5 };

  const delta = (userIndex % 3) - 1; // -1,0,1
  const safety = clamp(cityBase.safety + delta, 1, 10);
  const cost = clamp(cityBase.cost + (delta === 1 ? 0 : -1), 1, 10);
  const traffic = clamp(cityBase.traffic + (userIndex % 2 === 0 ? 1 : 0), 1, 10);
  const cleanliness = clamp(cityBase.cleanliness + (userIndex % 2 === 1 ? 1 : 0), 1, 10);
  const overall = clamp(Math.round((safety + cost + traffic + cleanliness) / 4), 1, 10);

  return { safety, cost, traffic, cleanliness, overall };
}

function buildCityDoc(c) {
  return {
    name: c.name,
    state: c.state,
    slug: c.slug,
    lat: c.lat ?? null,
    lng: c.lng ?? null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function buildEmptyStats(cityId) {
  return {
    cityId,
    count: 0,
    sums: { safety: 0, cost: 0, traffic: 0, cleanliness: 0, overall: 0 },
    livability: { version: "v0", score: null },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function toNumOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function clamp0to100(n) {
  if (n == null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}
function buildMetricsPatch(cityId, m) {
  return {
    cityId,
    medianRent: toNumOrNull(m?.medianRent),
    population: toNumOrNull(m?.population),
    safetyScore: clamp0to100(toNumOrNull(m?.safetyScore)),
    meta: { source: "manual:v1", syncedAt: admin.firestore.FieldValue.serverTimestamp() },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

// --------------------
// Wipes
// --------------------

async function wipeAllReviews() {
  console.log("⚠️  Wiping ALL reviews...");
  let total = 0;
  while (true) {
    const snap = await db.collection("reviews").limit(300).get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    total += snap.size;
    console.log(`Deleted ${total}...`);
    if (snap.size < 300) break;
  }
  console.log(`✅ Wiped ${total} total reviews.`);
}

async function wipeSeededReviews(seedUserIds) {
  console.log("Wiping seeded reviews only...");
  let deletedTotal = 0;

  for (const cityId of CITY_IDS) {
    const snap = await db.collection("reviews").where("cityId", "==", cityId).get();
    if (snap.empty) continue;

    const refs = snap.docs
      .filter((d) => seedUserIds.includes(d.data()?.userId))
      .map((d) => d.ref);

    for (const refsChunk of chunk(refs, 450)) {
      const batch = db.batch();
      refsChunk.forEach((r) => batch.delete(r));
      await batch.commit();
    }

    deletedTotal += refs.length;
  }

  console.log(`✅ Deleted ${deletedTotal} seeded review(s).`);
}

// --------------------
// Main
// --------------------

async function main() {
  // 0) Optional wipes
  if (WIPE_ALL_REVIEWS) await wipeAllReviews();
  if (WIPE_SEEDED_REVIEWS) await wipeSeededReviews(USERS.map((u) => u.id));

  // 1) Seed cities + reset city_stats
  console.log("Seeding cities + resetting city_stats...");
  {
    const batch = db.batch();

    for (const c of CITIES) {
      const cityRef = db.collection("cities").doc(c.slug);
      batch.set(cityRef, buildCityDoc(c), { merge: true });

      const statsRef = db.collection("city_stats").doc(c.slug);
      batch.set(statsRef, buildEmptyStats(c.slug), { merge: false });
    }

    await batch.commit();
    console.log(`✅ Seeded ${CITIES.length} cities and reset city_stats.`);
  }

  // 2) Upsert users
  console.log("Seeding users...");
  {
    for (const usersChunk of chunk(USERS, 450)) {
      const batch = db.batch();
      for (const u of usersChunk) {
        const ref = db.collection("users").doc(u.id);

        // don’t overwrite createdAt if rerun
        const snap = await ref.get();
        const exists = snap.exists;

        const payload = {
          email: u.email,
          displayName: u.displayName,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (!exists) payload.createdAt = admin.firestore.FieldValue.serverTimestamp();

        batch.set(ref, payload, { merge: true });
      }
      await batch.commit();
    }
    console.log(`✅ Upserted ${USERS.length} users.`);
  }

  // 3) Upsert 25 reviews (1 per user per city)
  console.log("Seeding reviews...");
  {
    const reviewDocs = [];
    CITY_IDS.forEach((cityId, cityIndex) => {
      USERS.forEach((u, userIndex) => {
        reviewDocs.push({
          reviewId: makeReviewId(u.id, cityId),
          userId: u.id,
          cityId,
          ratings: generateRatings(cityIndex, userIndex),
          comment: "Test Comment",
        });
      });
    });

    for (const docsChunk of chunk(reviewDocs, 450)) {
      const batch = db.batch();

      for (const r of docsChunk) {
        const ref = db.collection("reviews").doc(r.reviewId);
        const snap = await ref.get();
        const exists = snap.exists;

        const payload = {
          userId: r.userId,
          cityId: r.cityId,
          ratings: r.ratings,
          comment: r.comment,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (!exists) payload.createdAt = admin.firestore.FieldValue.serverTimestamp();

        batch.set(ref, payload, { merge: true });
      }

      await batch.commit();
    }

    console.log(`✅ Upserted ${reviewDocs.length} reviews.`);
  }

  // 4) Optional manual metrics
  if (!SKIP_METRICS) {
    console.log("Syncing manual city_metrics...");
    let batch = db.batch();
    let ops = 0;

    for (const cityId of Object.keys(METRICS)) {
      const ref = db.collection("city_metrics").doc(cityId);
      batch.set(ref, buildMetricsPatch(cityId, METRICS[cityId]), { merge: true });
      ops += 1;

      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
    console.log(`✅ Synced manual metrics for ${Object.keys(METRICS).length} cities.`);
  }

  // 5) Recompute stats from reviews for seeded cities (this also recomputes livability)
  console.log("Recomputing city_stats from reviews...");
  for (const cityId of CITY_IDS) {
    const stats = await recomputeCityStatsFromReviews(cityId);
    console.log(`✅ ${cityId}: count=${stats.count}`);
  }

  console.log("🎉 DEV INIT COMPLETE");
}

main().catch((e) => {
  console.error("❌ devInit failed:", e);
  process.exitCode = 1;
});
