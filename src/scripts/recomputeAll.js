// src/scripts/recomputeAll.js
// Run:
//   node src/scripts/recomputeAll.js --all
//   node src/scripts/recomputeAll.js --city san-diego-ca
//
// Recomputes:
// - city_stats.count + city_stats.sums from reviews (source of truth)
// - then recomputes livability (your util already does this)

const { initAdmin } = require("./lib/initAdmin");
initAdmin();

const { db } = require("../config/firebase");
const { recomputeCityStatsFromReviews } = require("../utils/cityStats");

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}
function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  const all = hasFlag("--all");
  const city = getArg("--city");

  if (!all && !city) {
    console.error("Choose one:\n  --all\n  --city <slug>");
    process.exit(1);
  }
  if (all && city) {
    console.error("Use either --all OR --city, not both.");
    process.exit(1);
  }

  let cityIds = [];
  if (all) {
    const snap = await db.collection("cities").get();
    cityIds = snap.docs.map((d) => d.id);
  } else {
    cityIds = [String(city).trim().toLowerCase()];
  }

  if (cityIds.length === 0) {
    console.log("No cities found. Nothing to do.");
    return;
  }

  console.log(`Recomputing stats from reviews for ${cityIds.length} cities...`);

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

  console.log(`Done. OK=${ok} FAIL=${fail}`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exitCode = 1;
});
