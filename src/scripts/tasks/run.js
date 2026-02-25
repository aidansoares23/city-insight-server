// src/scripts/tasks/run.js
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

async function taskRun(opts = {}) {
  const { steps } = opts;
  if (!steps || steps.length === 0) throw new Error("run requires --steps");

  for (const step of steps) {
    const fn = STEP_MAP[step];
    if (!fn)
      throw new Error(
        `unknown step "${step}". allowed: ${Object.keys(STEP_MAP).join(", ")}`,
      );

    console.log(`\n=== step: ${step} ===`);
    await fn(opts); // pass through options
  }

  console.log("\n✅ run complete.");
}

module.exports = { taskRun };
