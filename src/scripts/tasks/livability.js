// src/scripts/tasks/livability.js
const { db } = require("../../config/firebase");
const { recomputeCityLivability } = require("../../utils/cityStats");

async function taskLivability({
  all = false,
  city = null,
  dryRun = false,
} = {}) {
  if (!all && !city)
    throw new Error("livability requires --all or --city <slug>");
  if (all && city) throw new Error("use either --all OR --city, not both");

  const cityIds = all
    ? (await db.collection("cities").get()).docs.map((d) => d.id)
    : [city];

  if (dryRun) {
    console.log(
      `[dry-run] would recompute livability for ${cityIds.length} cities`,
    );
    return { touchedCityIds: cityIds };
  }

  for (const cityId of cityIds) {
    const livability = await recomputeCityLivability(cityId);
    console.log(`[livability] ${cityId}:`, livability);
  }

  return { touchedCityIds: cityIds };
}

module.exports = { taskLivability };
