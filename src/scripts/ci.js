#!/usr/bin/env node
const { Command } = require("commander");
// const { initAdmin } = require("../scripts/lib/initAdmin");
const { initAdmin } = require("./lib/initAdmin");

// Tasks
const { taskMetrics } = require("./tasks/metrics");
const { taskSafety } = require("./tasks/safety");
const { taskStats } = require("./tasks/stats");
const { taskLivability } = require("./tasks/livability");
const { taskRun } = require("./tasks/run");

console.log("[debug] ci.js path:", __filename);
console.log("[debug] metrics resolves to:", require.resolve("./tasks/metrics"));

function parseCities(val) {
  if (!val) return null;
  return String(val)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function withAdmin(fn) {
  initAdmin();
  return await fn(); // important: await so rejections propagate reliably
}

const program = new Command();

program
  .name("ci")
  .description("City Insight admin scripts (safe CLI)")
  .showHelpAfterError()
  .configureHelp({ sortSubcommands: true })
  .option("--dry-run", "log what would happen, write nothing", false)
  .option("--verbose", "more logs", false);

program
  .command("metrics")
  .description("Sync objective metrics (ACS population/rent)")
  .option("--cities <slugs>", "comma-separated city ids")
  .action((opts, cmd) =>
    withAdmin(() =>
      taskMetrics({
        cities: parseCities(opts.cities),
        dryRun: cmd.parent.opts().dryRun,
        verbose: cmd.parent.opts().verbose,
      }),
    ),
  );

program
  .command("safety")
  .description("Sync safety from per-city CSV files")
  .option("--dir <path>", "directory containing CSV files", null)
  .action((opts, cmd) =>
    withAdmin(() =>
      taskSafety({
        dir: opts.dir ?? null,
        dryRun: cmd.parent.opts().dryRun,
        verbose: cmd.parent.opts().verbose,
      }),
    ),
  );

program
  .command("stats")
  .description("Recompute city_stats from reviews (source of truth)")
  .option("--all", "recompute for all cities", false)
  .option("--city <slug>", "single city id")
  .action((opts, cmd) =>
    withAdmin(() =>
      taskStats({
        all: !!opts.all,
        city: opts.city ? String(opts.city).trim().toLowerCase() : null,
        dryRun: cmd.parent.opts().dryRun,
        verbose: cmd.parent.opts().verbose,
      }),
    ),
  );

program
  .command("livability")
  .description("Recompute livability only (from stats+metrics)")
  .option("--all", "recompute for all cities", false)
  .option("--city <slug>", "single city id")
  .action((opts, cmd) =>
    withAdmin(() =>
      taskLivability({
        all: !!opts.all,
        city: opts.city ? String(opts.city).trim().toLowerCase() : null,
        dryRun: cmd.parent.opts().dryRun,
        verbose: cmd.parent.opts().verbose,
      }),
    ),
  );

program
  .command("run")
  .description("Run an explicit pipeline (requires --steps)")
  .requiredOption(
    "--steps <list>",
    "comma-separated steps: metrics,safety,stats,livability",
  )
  .option(
    "--cities <slugs>",
    "comma-separated city ids (for metrics/livability)",
  )
  .option("--dir <path>", "CSV dir (for safety)", null)
  .option("--all", "all cities (for stats/livability)", false)
  .option("--city <slug>", "single city (for stats/livability)")
  .action((opts, cmd) =>
    withAdmin(() =>
      taskRun({
        steps: String(opts.steps)
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
        cities: parseCities(opts.cities),
        dir: opts.dir ?? null,
        all: !!opts.all,
        city: opts.city ? String(opts.city).trim().toLowerCase() : null,
        dryRun: cmd.parent.opts().dryRun,
        verbose: cmd.parent.opts().verbose,
      }),
    ),
  );

program
  .command("weekly-refresh")
  .description(
    "Run the standard weekly pipeline: metrics -> safety -> stats -> livability",
  )
  .option("--dir <path>", "CSV dir (for safety)", null)
  .option("--all", "all cities (default true)", true)
  .action((opts, cmd) =>
    withAdmin(() =>
      taskRun({
        steps: ["metrics", "safety", "stats", "livability"],
        dir: opts.dir ?? null,
        all: true,
        dryRun: cmd.parent.opts().dryRun,
        verbose: cmd.parent.opts().verbose,
      }),
    ),
  );

// IMPORTANT: No default action. If no args, show help and exit 0.
if (process.argv.length <= 2) {
  program.help(); // prints + exits
}

program.parseAsync(process.argv).catch((e) => {
  console.error("❌ Script failed:", e?.stack || e);
  process.exitCode = 1;
});
