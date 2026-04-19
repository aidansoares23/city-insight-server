const { db, admin } = require("../../config/firebase");
const { generateCitySummary } = require("../../services/aiSummaryService");
const { AI_MODEL } = require("../../config/anthropic");

/**
 * Bulk-generates AI city summaries and writes them to the `city_summaries` collection.
 * Skips cities that already have an up-to-date summary unless `--force` is set.
 * @param {{ cities?: string[]|null, force?: boolean, dryRun?: boolean, verbose?: boolean }} options
 */
async function taskSummaries({ cities, force = false, dryRun = false, verbose = false } = {}) {
  console.log("=== summaries ===");

  const snap = await db.collection("cities").get();
  const allCityDocs = snap.docs.map((doc) => ({ id: doc.id, name: doc.data()?.name ?? doc.id }));

  const targetIds = cities ? new Set(cities) : null;
  const cityDocs = targetIds ? allCityDocs.filter((c) => targetIds.has(c.id)) : allCityDocs;

  console.log(`Processing ${cityDocs.length} cities…`);

  // Batch-read all existing summaries before the loop to avoid N serial reads.
  let existingSummaries = new Map(); // cityId -> boolean (exists)
  if (!force && cityDocs.length > 0) {
    const summaryRefs = cityDocs.map((c) => db.collection("city_summaries").doc(c.id));
    const summarySnaps = await db.getAll(...summaryRefs);
    summarySnaps.forEach((snap, idx) => {
      existingSummaries.set(cityDocs[idx].id, snap.exists);
    });
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const city of cityDocs) {
    // Check if an up-to-date summary already exists (skip unless --force)
    if (!force) {
      if (existingSummaries.get(city.id)) {
        if (verbose) console.log(`[summaries] skip (cached): ${city.id}`);
        skipped++;
        continue;
      }
    }

    if (dryRun) {
      console.log(`[dry-run][summaries] would generate summary for ${city.id}`);
      updated++;
      continue;
    }

    try {
      const { summary, reviewCount } = await generateCitySummary(city.id);
      await db.collection("city_summaries").doc(city.id).set(
        {
          cityId: city.id,
          summary,
          reviewCountAtGeneration: reviewCount,
          generatedAt: admin.firestore.FieldValue.serverTimestamp(),
          model: AI_MODEL,
        },
        { merge: true },
      );
      updated++;
      if (verbose) console.log(`[summaries] generated ${city.id}: "${summary.slice(0, 80)}…"`);
    } catch (err) {
      console.error(`[summaries] failed ${city.id}:`, err.message);
      failed++;
    }

    // Small delay to avoid hammering the Anthropic API
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(
    `✅ summaries done. Updated: ${updated}, Skipped: ${skipped}, Failed: ${failed} / ${cityDocs.length} cities.`,
  );
  return { updated, skipped, failed };
}

module.exports = { taskSummaries };
