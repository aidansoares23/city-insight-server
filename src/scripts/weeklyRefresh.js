require("dotenv").config();
const { execSync } = require("child_process");

function run(cmd) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

try {
  console.log("\nWEEKLY REFRESH\n");
  run("node src/scripts/syncMetrics.js");
  run("node src/scripts/syncSafetyFromCsv.js");
  console.log("\n✅ WEEKLY REFRESH COMPLETE\n");
} catch (e) {
  console.error("\n❌ WEEKLY REFRESH FAILED\n", e.message);
  process.exit(1);
}
