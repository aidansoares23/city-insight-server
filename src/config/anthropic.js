const Anthropic = require("@anthropic-ai/sdk");
const { ANTHROPIC_API_KEY } = require("./env");

/** Shared Anthropic client instance — initialized once and reused across the app. */
const anthropicClient = new Anthropic.default({ apiKey: ANTHROPIC_API_KEY });

/** The Claude model used for all AI features (query endpoint and city summaries). */
const AI_MODEL = "claude-haiku-4-5-20251001";

module.exports = { anthropicClient, AI_MODEL };
