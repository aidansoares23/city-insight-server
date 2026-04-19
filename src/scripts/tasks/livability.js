const { db } = require("../../config/firebase");
const { updatedTimestamp } = require("../../utils/timestamps");
const {
  computeAveragesFromStats,
  computeAverages,
  normalizeFlatCityMetrics,
  computeLivabilityNorms,
  recomputeCityLivability,
  recomputeCityLivabilityWithNorms,
} = require("../../utils/cityStats");

/**
 * Recomputes the livability score for one or all cities.
 *
 * When `--all` is used:
 *   1. Fetches every city's current stats and metrics.
 *   2. Computes dataset-wide distribution norms (min/max per signal).
 *   3. Stores norms in `livability_config/norms` so real-time review transactions
 *      can read them without performing a full-dataset scan.
 *   4. Recomputes every city's score against the fresh norms.
 *
 * When `--city` is used:
 *   Recomputes a single city using the norms already stored in Firestore.
 *   Run `--all` first if norms have never been computed.
 *
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

  let norms = null;
  if (all) {
    // Phase 1: fetch all stats + metrics in parallel, compute norms.
    console.log(`[livability] computing norms across ${cityIds.length} cities…`);

    const [statsSnaps, metricsSnaps] = await Promise.all([
      Promise.all(cityIds.map((id) => db.collection("city_stats").doc(id).get())),
      Promise.all(cityIds.map((id) => db.collection("city_metrics").doc(id).get())),
    ]);

    const cityDataList = cityIds.map((id, i) => {
      const statsDoc   = statsSnaps[i].exists   ? statsSnaps[i].data()   || {} : {};
      const metricsDoc = metricsSnaps[i].exists ? metricsSnaps[i].data() || {} : {};
      const { count, sums } = computeAveragesFromStats(statsDoc);
      const averages = computeAverages(count, sums);
      const metrics  = normalizeFlatCityMetrics(id, metricsDoc);
      return { averages, metrics };
    });

    norms = computeLivabilityNorms(cityDataList);
    console.log("[livability] norms:", JSON.stringify(norms, null, 2));

    if (!dryRun) {
      // Phase 2: store norms so review transactions and single-city recomputes can use them.
      await db
        .collection("livability_config")
        .doc("norms")
        .set({ version: "v1", ...norms, ...updatedTimestamp() });
      console.log("[livability] norms stored in livability_config/norms");
    }
  }

  if (dryRun) {
    console.log(
      `[dry-run] would recompute livability for ${cityIds.length} cities`,
    );
    return { touchedCityIds: cityIds };
  }

  // Phase 3: recompute each city in parallel batches.
  // When --all is used, pass the locally-computed norms so each transaction skips
  // the livability_config/norms read (it's the same doc every time).
  // When --city is used, fall back to recomputeCityLivability which reads norms itself.
  const BATCH_SIZE = 20;
  for (let i = 0; i < cityIds.length; i += BATCH_SIZE) {
    const batch = cityIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((cityId) =>
        all
          ? recomputeCityLivabilityWithNorms(cityId, norms)
          : recomputeCityLivability(cityId)
      )
    );
    batch.forEach((cityId, idx) => {
      console.log(`[livability] ${cityId}:`, results[idx]);
    });
  }

  return { touchedCityIds: cityIds };
}

module.exports = { taskLivability };
