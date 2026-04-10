#!/usr/bin/env node
const { Command } = require("commander");
const { initAdmin } = require("./lib/initAdmin");

// Tasks
const { taskMetrics } = require("./tasks/metrics");
const { taskSafety } = require("./tasks/safety");
const { taskSafetyApi } = require("./tasks/safetyApi");
const { taskStats } = require("./tasks/stats");
const { taskLivability } = require("./tasks/livability");
const { taskCityUpsert, taskCityUpsertBatch } = require("./tasks/cities");
const { taskAttractions } = require("./tasks/attractions");
const { taskSummaries } = require("./tasks/summaries");
const { taskAirQuality } = require("./tasks/airQuality");
const { taskRun } = require("./tasks/run");

/** Parses a comma-separated city slug string into a lowercase array, or `null` if empty. */
function parseCities(val) {
  if (!val) return null;
  return String(val)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Initializes Firebase Admin then runs `fn()`; used to wrap each CLI command action. */
async function withAdmin(fn) {
  initAdmin();
  return await fn();
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
  .command("safety-api")
  .description("Sync safety scores from FBI Crime Data Explorer API")
  .option("--cities <slugs>", "comma-separated city ids")
  .action((opts, cmd) =>
    withAdmin(() =>
      taskSafetyApi({
        cities: parseCities(opts.cities),
        dryRun: cmd.parent.opts().dryRun,
        verbose: cmd.parent.opts().verbose,
      }),
    ),
  );

program
  .command("safety")
  .description("Sync safety from per-city CSV files (legacy)")
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
  .action(async (opts, cmd) => {
    const result = await withAdmin(() =>
      taskStats({
        all: !!opts.all,
        city: opts.city ? String(opts.city).trim().toLowerCase() : null,
        dryRun: cmd.parent.opts().dryRun,
        verbose: cmd.parent.opts().verbose,
      }),
    );
    if (result?.fail) process.exitCode = 1;
  });

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
  .command("city-upsert-batch")
  .description("Batch create/update cities from a JSON file")
  .requiredOption(
    "--file <path>",
    "path to JSON file containing array of city objects",
  )
  .action((opts, cmd) =>
    withAdmin(() =>
      taskCityUpsertBatch({
        file: opts.file,
        dryRun: cmd.parent.opts().dryRun,
      }),
    ),
  );

program
  .command("city-upsert")
  .description("Create or update a single city doc (non-destructive)")
  .requiredOption("--slug <slug>", "city slug/doc id, e.g. san-luis-obispo-ca")
  .requiredOption("--name <name>", "display name, e.g. San Luis Obispo")
  .requiredOption("--state <state>", "2-letter state, e.g. CA")
  .option("--lat <lat>", "latitude")
  .option("--lng <lng>", "longitude")
  .option("--tagline <tagline>", "short city tagline")
  .option("--description <description>", "long city description")
  .option(
    "--highlights <items>",
    "comma-separated highlights, e.g. Beaches,Walkability,Weather",
  )
  .action((opts, cmd) =>
    withAdmin(() =>
      taskCityUpsert({
        slug: opts.slug,
        name: opts.name,
        state: opts.state,
        lat: opts.lat,
        lng: opts.lng,
        tagline: opts.tagline,
        description: opts.description,
        highlights: opts.highlights,
        dryRun: cmd.parent.opts().dryRun,
      }),
    ),
  );

program
  .command("attractions")
  .description("Sync things-to-do attractions from Foursquare Places API")
  .option("--cities <slugs>", "comma-separated city ids")
  .action((opts, cmd) =>
    withAdmin(() =>
      taskAttractions({
        cities: parseCities(opts.cities),
        dryRun: cmd.parent.opts().dryRun,
        verbose: cmd.parent.opts().verbose,
      }),
    ),
  );

program
  .command("summaries")
  .description(
    "Generate AI city snapshot summaries (city_summaries collection)",
  )
  .option("--cities <slugs>", "comma-separated city ids")
  .option("--force", "regenerate even if a summary already exists", false)
  .action((opts, cmd) =>
    withAdmin(() =>
      taskSummaries({
        cities: parseCities(opts.cities),
        force: !!opts.force,
        dryRun: cmd.parent.opts().dryRun,
        verbose: cmd.parent.opts().verbose,
      }),
    ),
  );

program
  .command("air-quality")
  .description(
    "Sync air quality data (PM2.5 → AQI) from OpenAQ into city_metrics",
  )
  .option("--cities <slugs>", "comma-separated city ids")
  .action((opts, cmd) =>
    withAdmin(() =>
      taskAirQuality({
        cities: parseCities(opts.cities),
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
    "Run the standard weekly pipeline: metrics -> safety-api -> air-quality -> stats -> livability",
  )
  .action((opts, cmd) =>
    withAdmin(() =>
      taskRun({
        steps: ["metrics", "safety-api", "air-quality", "stats", "livability"],
        all: true,
        dryRun: cmd.parent.opts().dryRun,
        verbose: cmd.parent.opts().verbose,
      }),
    ),
  );

if (process.argv.length <= 2) {
  program.help(); // prints + exits
}

program.parseAsync(process.argv).catch((e) => {
  console.error("❌ Script failed:", e?.stack || e);
  process.exitCode = 1;
});
