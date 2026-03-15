const { db } = require("../../config/firebase");
const { recomputeCityLivability } = require("../../utils/cityStats");

/**
 * Recomputes the livability score (from existing stats + metrics) for one or all cities.
 * Requires `--all` or `--city`; passing both is an error.
 * @param {{ all?: boolean, city?: string|null, dryRun?: boolean }} [options]
 * @returns {Promise<{ touchedCityIds: string[] }>}
 */
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
