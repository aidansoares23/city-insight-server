// src/scripts/tasks/stats.js
const { db } = require("../../config/firebase");
const { recomputeCityStatsFromReviews } = require("../../utils/cityStats");

async function taskStats({ all = false, city = null, dryRun = false } = {}) {
  if (!all && !city) throw new Error("stats requires --all or --city <slug>");
  if (all && city) throw new Error("use either --all OR --city, not both");

  const cityIds = all
    ? (await db.collection("cities").get()).docs.map((d) => d.id)
    : [city];

  if (dryRun) {
    console.log(`[dry-run] would recompute stats for ${cityIds.length} cities`);
    return { touchedCityIds: cityIds };
  }

  let ok = 0;
  let fail = 0;

  for (const cityId of cityIds) {
    try {
      const stats = await recomputeCityStatsFromReviews(cityId);
      console.log(`✅ ${cityId}: count=${stats.count}`);
      ok += 1;
    } catch (e) {
      console.error(`❌ ${cityId}:`, e?.message || e);
      fail += 1;
    }
  }

  if (fail) process.exitCode = 1;
  return { touchedCityIds: cityIds, ok, fail };
}

module.exports = { taskStats };
