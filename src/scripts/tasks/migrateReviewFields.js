// One-time migration: rename cost→affordability and traffic→walkability
// on all Firestore review documents and city_stats sums, then recompute
// city_stats for every affected city.
//
// Run via ci.js:
//   node src/scripts/ci.js --task migrateReviewFields [--dryRun]
//
// Or directly:
//   node -e "require('./src/scripts/lib/initAdmin').initAdmin(); require('./src/scripts/tasks/migrateReviewFields').taskMigrateReviewFields().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);})"

const { db, admin } = require("../../config/firebase");
const { recomputeCityStatsFromReviews } = require("../../utils/cityStats");

const BATCH_LIMIT = 450;

/**
 * One-time migration: renames `cost`→`affordability` and `traffic`→`walkability`
 * on all review documents and `city_stats` sums, then recomputes `city_stats` from
 * the migrated reviews. Processes reviews in batches of 300; writes in batches of 450.
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<{ reviewsScanned: number, reviewsUpdated: number, statsUpdated: number }>}
 */
async function taskMigrateReviewFields({ dryRun = false } = {}) {
  console.log(`[migrateReviewFields] dryRun=${dryRun}`);

  // ── 1. Migrate reviews collection ────────────────────────────────────────
  console.log("\n── Step 1: migrating review documents ──");
  let reviewsScanned = 0;
  let reviewsUpdated = 0;
  let lastDoc = null;

  while (true) {
    let q = db.collection("reviews").orderBy(admin.firestore.FieldPath.documentId()).limit(300);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    const toWrite = [];
    for (const doc of snap.docs) {
      reviewsScanned++;
      const data = doc.data() || {};
      const ratings = data.ratings || {};

      const hasCost    = Object.prototype.hasOwnProperty.call(ratings, "cost");
      const hasTraffic = Object.prototype.hasOwnProperty.call(ratings, "traffic");

      if (!hasCost && !hasTraffic) continue; // already migrated

      const newRatings = { ...ratings };
      if (hasCost) {
        newRatings.affordability = ratings.cost;
        delete newRatings.cost;
      }
      if (hasTraffic) {
        newRatings.walkability = ratings.traffic;
        delete newRatings.traffic;
      }

      toWrite.push({ ref: doc.ref, newRatings });
    }

    if (!dryRun && toWrite.length > 0) {
      for (let i = 0; i < toWrite.length; i += BATCH_LIMIT) {
        const batch = db.batch();
        for (const { ref, newRatings } of toWrite.slice(i, i + BATCH_LIMIT)) {
          batch.update(ref, { ratings: newRatings });
        }
        await batch.commit();
      }
    }

    reviewsUpdated += toWrite.length;
    console.log(
      `  scanned=${reviewsScanned} updated=${reviewsUpdated}${dryRun ? " (dry-run)" : ""}`,
    );

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 300) break;
  }

  console.log(`\n  Reviews done: scanned=${reviewsScanned}, updated=${reviewsUpdated}`);

  // ── 2. Migrate city_stats sums ────────────────────────────────────────────
  console.log("\n── Step 2: migrating city_stats sums ──");
  const statsSnap = await db.collection("city_stats").get();
  let statsUpdated = 0;

  if (!dryRun && !statsSnap.empty) {
    for (let i = 0; i < statsSnap.docs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      for (const doc of statsSnap.docs.slice(i, i + BATCH_LIMIT)) {
        const data = doc.data() || {};
        const sums = data.sums || {};

        const hasCost    = Object.prototype.hasOwnProperty.call(sums, "cost");
        const hasTraffic = Object.prototype.hasOwnProperty.call(sums, "traffic");

        if (!hasCost && !hasTraffic) continue;

        const newSums = { ...sums };
        if (hasCost) {
          newSums.affordability = sums.cost;
          delete newSums.cost;
        }
        if (hasTraffic) {
          newSums.walkability = sums.traffic;
          delete newSums.traffic;
        }

        batch.update(doc.ref, { sums: newSums });
        statsUpdated++;
      }
      await batch.commit();
    }
  } else if (dryRun) {
    for (const doc of statsSnap.docs) {
      const sums = doc.data()?.sums || {};
      if (
        Object.prototype.hasOwnProperty.call(sums, "cost") ||
        Object.prototype.hasOwnProperty.call(sums, "traffic")
      ) {
        statsUpdated++;
      }
    }
  }

  console.log(`  city_stats updated: ${statsUpdated}${dryRun ? " (dry-run)" : ""}`);

  // ── 3. Recompute city_stats from (now-migrated) reviews ──────────────────
  if (!dryRun) {
    console.log("\n── Step 3: recomputing city_stats from reviews ──");
    const cityIds = statsSnap.docs.map((d) => d.id);
    let ok = 0;
    let fail = 0;
    for (const cityId of cityIds) {
      try {
        const stats = await recomputeCityStatsFromReviews(cityId);
        console.log(`  ✅ ${cityId}: count=${stats.count}`);
        ok++;
      } catch (e) {
        console.error(`  ❌ ${cityId}:`, e?.message || e);
        fail++;
      }
    }
    console.log(`\n  Recompute done: ok=${ok}, fail=${fail}`);
  } else {
    console.log("\n── Step 3: skipped (dry-run) ──");
  }

  console.log("\n✅ migrateReviewFields complete.");
  return { reviewsScanned, reviewsUpdated, statsUpdated };
}

module.exports = { taskMigrateReviewFields };
