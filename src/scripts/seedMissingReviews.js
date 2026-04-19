// Run: node src/scripts/seedMissingReviews.js
//
// Seeds fake reviews (using seed users) for every city in Firestore that
// has no reviews yet (city_stats.count === 0 or no city_stats doc).
// Already-reviewed cities are left untouched.
//
// Flags:
//   --dry-run            List which cities would be seeded without writing anything
//   --wipeSeededReviews  Delete all seed-user reviews across every city, then re-seed

const { initAdmin } = require("./lib/initAdmin");
initAdmin();

const { admin, db } = require("../config/firebase");
const { recomputeCityStatsFromReviews } = require("../utils/cityStats");
const { USERS, makeReviewId, chunk, generateRatings, generateComment } = require("./lib/seedUtils");

const DRY_RUN             = process.argv.includes("--dry-run");
const WIPE_SEEDED_REVIEWS = process.argv.includes("--wipeSeededReviews");

/**
 * Deletes all reviews authored by seed users across every city,
 * then resets each affected city's city_stats to count=0 so the
 * seeding loop below picks them up.
 */
async function wipeSeededReviews() {
  const seedUserIds = USERS.map((u) => u.id);
  const affectedCityIds = new Set();
  let deletedTotal = 0;

  // Query per seed user — simpler than per-city for a large city list
  for (const userId of seedUserIds) {
    const snap = await db.collection("reviews").where("userId", "==", userId).get();
    if (snap.empty) continue;

    snap.docs.forEach((d) => affectedCityIds.add(d.data().cityId));

    for (const refsChunk of chunk(snap.docs.map((d) => d.ref), 450)) {
      const batch = db.batch();
      refsChunk.forEach((r) => batch.delete(r));
      await batch.commit();
    }

    deletedTotal += snap.size;
  }

  console.log(`✅ Deleted ${deletedTotal} seeded review(s) across ${affectedCityIds.size} cities.`);

  // Zero out city_stats so the cities appear in the "needs reviews" list
  const emptyStats = (cityId) => ({
    cityId,
    count: 0,
    sums: { safety: 0, affordability: 0, walkability: 0, cleanliness: 0, overall: 0 },
    livability: { version: "v0", score: null },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  for (const cityIdChunk of chunk([...affectedCityIds], 450)) {
    const batch = db.batch();
    cityIdChunk.forEach((cityId) =>
      batch.set(db.collection("city_stats").doc(cityId), emptyStats(cityId), { merge: false }),
    );
    await batch.commit();
  }

  console.log(`✅ Reset city_stats for ${affectedCityIds.size} cities.`);
}

async function ensureSeedUsers() {
  for (const usersChunk of chunk(USERS, 450)) {
    const batch = db.batch();
    for (const u of usersChunk) {
      const ref = db.collection("users").doc(u.id);
      const snap = await ref.get();
      const payload = {
        email: u.email,
        displayName: u.displayName,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (!snap.exists) payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
      batch.set(ref, payload, { merge: true });
    }
    await batch.commit();
  }
}

async function main() {
  // 0) Optional wipe
  if (WIPE_SEEDED_REVIEWS) {
    console.log("Wiping seeded reviews across all cities...");
    await wipeSeededReviews();
  }

  // 1) Fetch all city slugs from Firestore
  console.log("Fetching all cities...");
  const citiesSnap = await db.collection("cities").get();
  if (citiesSnap.empty) {
    console.log("No cities found in Firestore. Nothing to seed.");
    process.exit(0);
  }
  const allCityIds = citiesSnap.docs.map((d) => d.id);
  console.log(`Found ${allCityIds.length} cities.`);

  // 2) Determine which cities have no reviews via city_stats.count
  const needsReviews = [];
  for (const cityId of allCityIds) {
    const statsSnap = await db.collection("city_stats").doc(cityId).get();
    const count = statsSnap.exists ? (statsSnap.data()?.count ?? 0) : 0;
    if (count === 0) needsReviews.push(cityId);
  }

  if (needsReviews.length === 0) {
    console.log("All cities already have reviews. Nothing to seed.");
    process.exit(0);
  }

  console.log(`Cities needing reviews (${needsReviews.length}):`);
  needsReviews.forEach((id) => console.log(`  - ${id}`));

  if (DRY_RUN) {
    console.log("\n--dry-run: no writes performed.");
    process.exit(0);
  }

  // 3) Ensure seed users exist
  console.log("\nEnsuring seed users exist...");
  await ensureSeedUsers();
  console.log(`✅ Upserted ${USERS.length} seed users.`);

  // 4) Seed reviews for each city that needs them
  console.log("\nSeeding reviews...");
  let totalReviews = 0;

  for (const cityId of needsReviews) {
    const reviewDocs = USERS.map((u, userIndex) => {
      const ratings = generateRatings(cityId, userIndex);
      return {
        reviewId: makeReviewId(u.id, cityId),
        userId: u.id,
        cityId,
        ratings,
        comment: generateComment(cityId, ratings, userIndex),
      };
    });

    for (const docsChunk of chunk(reviewDocs, 450)) {
      const batch = db.batch();
      for (const r of docsChunk) {
        const ref = db.collection("reviews").doc(r.reviewId);
        const snap = await ref.get();
        const payload = {
          userId: r.userId,
          cityId: r.cityId,
          ratings: r.ratings,
          comment: r.comment,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (!snap.exists) payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
        batch.set(ref, payload, { merge: true });
      }
      await batch.commit();
    }

    totalReviews += reviewDocs.length;
    console.log(`  ✅ ${cityId}: seeded ${reviewDocs.length} reviews`);
  }

  // 5) Recompute city_stats for all seeded cities
  console.log("\nRecomputing city_stats...");
  for (const cityId of needsReviews) {
    const stats = await recomputeCityStatsFromReviews(cityId);
    console.log(`  ✅ ${cityId}: count=${stats.count}`);
  }

  console.log(`\n🎉 Done. Seeded ${totalReviews} reviews across ${needsReviews.length} cities.`);
}

main().catch((e) => {
  console.error("❌ seedMissingReviews failed:", e);
  process.exitCode = 1;
});
