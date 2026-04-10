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

const { initAdmin } = require("./lib/initAdmin");
initAdmin();

const { admin, db } = require("../config/firebase");
const { recomputeCityStatsFromReviews } = require("../utils/cityStats");
const { toNumOrNull, clamp0to100 } = require("../lib/numbers");
const { USERS, makeReviewId, chunk, generateRatings, generateComment } = require("./lib/seedUtils");

function hasFlag(name) {
  return process.argv.includes(name);
}

const WIPE_ALL_REVIEWS = hasFlag("--wipeAllReviews");
const WIPE_SEEDED_REVIEWS = hasFlag("--wipeSeededReviews");
const SKIP_METRICS = hasFlag("--skipMetrics");

if (WIPE_ALL_REVIEWS && WIPE_SEEDED_REVIEWS) {
  console.error(
    "Use either --wipeAllReviews OR --wipeSeededReviews, not both.",
  );
  process.exit(1);
}

const CITIES = [
  {
    slug: "san-francisco-ca",
    name: "San Francisco",
    state: "CA",
    lat: 37.7749,
    lng: -122.4194,
    tagline: "Iconic neighborhoods, career upside, and sticker-shock pricing.",
    description:
      "San Francisco packs dense, walkable pockets, world-class food, and stunning views into a small footprint. The tradeoff is cost—rent is high, space is tight, and prices add up fast. Transit is decent in many areas, and the city rewards people who like exploring on foot despite the hills.",
    highlights: [
      "Walkable pockets",
      "Food + parks",
      "Career access",
      "High rent",
    ],
  },
  {
    slug: "san-jose-ca",
    name: "San Jose",
    state: "CA",
    lat: 37.3382,
    lng: -121.8863,
    tagline: "Clean, spread out, and close to Silicon Valley jobs.",
    description:
      "San Jose feels more suburban than most people expect—lots of neighborhoods, lots of driving, and a calmer pace. It’s a practical base for tech work with good weather and generally tidy streets, but the nightlife and “big city” feel can be limited depending on where you live. Cost is still high compared to most of California.",
    highlights: [
      "Tech job hub",
      "Good weather",
      "Car-friendly",
      "Quieter vibe",
    ],
  },
  {
    slug: "los-angeles-ca",
    name: "Los Angeles",
    state: "CA",
    lat: 34.0522,
    lng: -118.2437,
    tagline:
      "Massive variety, incredible food, and traffic that sets the pace.",
    description:
      "Los Angeles is really a collection of cities—your experience depends heavily on neighborhood choice. The upside is endless options: culture, events, food, beaches, and career paths across industries. The downside is the commute math: traffic can dominate your day, and costs can climb quickly in the most desirable areas.",
    highlights: [
      "Neighborhood variety",
      "Food + culture",
      "Car required",
      "Traffic",
    ],
  },
  {
    slug: "san-diego-ca",
    name: "San Diego",
    state: "CA",
    lat: 32.7157,
    lng: -117.1611,
    tagline: "Beach-first lifestyle with strong day-to-day quality of life.",
    description:
      "San Diego is known for consistently good weather and an outdoorsy, relaxed rhythm. Many neighborhoods feel clean and safe, and the coastline access is a huge draw. It’s not cheap, but people often feel the lifestyle payoff is worth it if you’re into beaches, hiking, and being outside year-round.",
    highlights: [
      "Weather",
      "Outdoor lifestyle",
      "Coastal neighborhoods",
      "Still pricey",
    ],
  },
  {
    slug: "sacramento-ca",
    name: "Sacramento",
    state: "CA",
    lat: 38.5816,
    lng: -121.4944,
    tagline: "More space for the money, practical living, and hot summers.",
    description:
      "Sacramento offers a calmer pace than the Bay or LA with generally better housing value and easier day-to-day logistics. Downtown and midtown have grown into more lively areas with food and local events. Summers get very hot, but you’re close to weekend trips—Tahoe, the Bay, and the coast are all reachable.",
    highlights: [
      "Better value",
      "Calmer pace",
      "Hot summers",
      "Easy weekend trips",
    ],
  },
];

const CITY_IDS = CITIES.map((c) => c.slug);

// Manual dev metrics (swap for real providers later)
const METRICS = {
  "san-francisco-ca": {
    medianRent: 3400,
    population: 808988,
    safetyScore: null,
  },
  "san-jose-ca": { medianRent: 2900, population: 971233, safetyScore: null },
  "los-angeles-ca": {
    medianRent: 2500,
    population: 3820914,
    safetyScore: null,
  },
  "san-diego-ca": { medianRent: 2700, population: 1386932, safetyScore: null },
  "sacramento-ca": { medianRent: 1900, population: 526384, safetyScore: null },
};

function buildCityDoc(c) {
  return {
    name: c.name,
    state: c.state,
    slug: c.slug,
    lat: c.lat ?? null,
    lng: c.lng ?? null,
    tagline: c.tagline ?? null,
    description: c.description ?? null,
    highlights: Array.isArray(c.highlights) ? c.highlights : [],
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function buildEmptyStats(cityId) {
  return {
    cityId,
    count: 0,
    sums: { safety: 0, affordability: 0, walkability: 0, cleanliness: 0, overall: 0 },
    livability: { version: "v0", score: null },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function buildMetricsPatch(cityId, m) {
  return {
    cityId,
    medianRent: toNumOrNull(m?.medianRent),
    population: toNumOrNull(m?.population),
    safetyScore: clamp0to100(toNumOrNull(m?.safetyScore)),
    meta: {
      source: "manual:v1",
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

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
    const snap = await db
      .collection("reviews")
      .where("cityId", "==", cityId)
      .get();
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

async function main() {
  // 0) Optional wipes
  if (WIPE_ALL_REVIEWS) await wipeAllReviews();
  if (WIPE_SEEDED_REVIEWS) await wipeSeededReviews(USERS.map((u) => u.id));

  // 1) Seed cities + reset city_stats
  console.log("Seeding cities + resetting city_stats...");
  {
    const batch = db.batch();

    // NOTE: we read existing docs so createdAt is not overwritten
    for (const c of CITIES) {
      const cityRef = db.collection("cities").doc(c.slug);
      const snap = await cityRef.get();
      const exists = snap.exists;

      const payload = buildCityDoc(c);
      if (!exists)
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();

      batch.set(cityRef, payload, { merge: true });

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
        if (!exists)
          payload.createdAt = admin.firestore.FieldValue.serverTimestamp();

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
    CITY_IDS.forEach((cityId) => {
      USERS.forEach((u, userIndex) => {
        const ratings = generateRatings(cityId, userIndex);
        reviewDocs.push({
          reviewId: makeReviewId(u.id, cityId),
          userId: u.id,
          cityId,
          ratings,
          comment: generateComment(cityId, ratings, userIndex),
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
        if (!exists)
          payload.createdAt = admin.firestore.FieldValue.serverTimestamp();

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
      batch.set(ref, buildMetricsPatch(cityId, METRICS[cityId]), {
        merge: true,
      });
      ops += 1;

      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
    console.log(
      `✅ Synced manual metrics for ${Object.keys(METRICS).length} cities.`,
    );
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
