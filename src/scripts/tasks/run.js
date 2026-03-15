const { taskMetrics } = require("./metrics");
const { taskSafety } = require("./safety");
const { taskStats } = require("./stats");
const { taskLivability } = require("./livability");

const STEP_MAP = {
  metrics: taskMetrics,
  safety: taskSafety,
  stats: taskStats,
  livability: taskLivability,
};

// Steps that require --all or --city to be meaningful.
const STEPS_REQUIRING_SCOPE = new Set(["stats", "livability"]);

/**
 * Runs an ordered list of pipeline steps sequentially, passing all options through to each task.
 * Valid steps: `metrics`, `safety`, `stats`, `livability`.
 * Steps in `STEPS_REQUIRING_SCOPE` (stats, livability) require `opts.all` or `opts.city`.
 * @param {{ steps: string[], cities?: string[]|null, dir?: string|null, all?: boolean, city?: string|null, dryRun?: boolean, verbose?: boolean }} [opts]
 * @returns {Promise<void>}
 */
async function taskRun(opts = {}) {
  const { steps } = opts;
  if (!steps || steps.length === 0) throw new Error("run requires --steps");

  for (const step of steps) {
    const fn = STEP_MAP[step];
    if (!fn)
      throw new Error(
        `unknown step "${step}". allowed: ${Object.keys(STEP_MAP).join(", ")}`,
      );

    if (STEPS_REQUIRING_SCOPE.has(step) && !opts.all && !opts.city) {
      throw new Error(
        `step "${step}" requires --all or --city <slug>`,
      );
    }

    console.log(`\n=== step: ${step} ===`);
    await fn(opts); // pass through options
  }

  console.log("\n✅ run complete.");
}

module.exports = { taskRun };
