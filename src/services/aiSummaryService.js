const { admin, db } = require("../config/firebase");
const { anthropicClient, AI_MODEL } = require("../config/anthropic");
const { getCity, aggregateReviews } = require("./aiQueryService");
const REGENERATE_REVIEW_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Firestore helpers
// ---------------------------------------------------------------------------

async function getCachedSummary(cityId) {
  const snap = await db.collection("city_summaries").doc(cityId).get();
  return snap.exists ? snap.data() : null;
}

async function saveSummary(cityId, summary, reviewCount) {
  await db.collection("city_summaries").doc(cityId).set(
    {
      cityId,
      summary,
      reviewCountAtGeneration: reviewCount,
      generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      model: AI_MODEL,
    },
    { merge: true },
  );
}

/**
 * Returns true if the summary should be regenerated:
 * - No cached summary exists, or
 * - At least REGENERATE_REVIEW_THRESHOLD new reviews have been written since last generation.
 */
function shouldRegenerate(cached, currentReviewCount) {
  if (!cached) return true;
  const delta = (currentReviewCount || 0) - (cached.reviewCountAtGeneration || 0);
  return delta >= REGENERATE_REVIEW_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generates a 3–4 sentence AI city snapshot by calling Claude with the city's
 * profile data and recent review excerpts. No tool use — direct text generation only.
 * @param {string} cityId - City slug (e.g. "san-francisco-ca")
 * @returns {Promise<{ summary: string, reviewCount: number }>}
 */
async function generateCitySummary(cityId) {
  const [cityResult, reviewResult] = await Promise.all([
    getCity(cityId),
    aggregateReviews(cityId),
  ]);

  if (!cityResult.found || cityResult.cities.length === 0) {
    throw new Error(`City not found: ${cityId}`);
  }

  const city = cityResult.cities[0];
  const reviewCount = city.stats?.reviewCount ?? 0;

  // Build a concise data block for the prompt
  const dataLines = [
    `City: ${city.name}, ${city.state}`,
    city.tagline ? `Tagline: ${city.tagline}` : null,
    city.stats?.livabilityScore != null
      ? `Livability score: ${city.stats.livabilityScore}/100`
      : null,
    city.metrics?.safetyScore != null
      ? `Safety score: ${city.metrics.safetyScore}/10`
      : null,
    city.metrics?.medianRent != null
      ? `Median rent: $${city.metrics.medianRent.toLocaleString()}/mo`
      : null,
    city.metrics?.population != null
      ? `Population: ${city.metrics.population.toLocaleString()}`
      : null,
    city.stats?.averages
      ? `Community ratings — Overall: ${city.stats.averages.overall ?? "n/a"}/10, Safety: ${city.stats.averages.safety ?? "n/a"}/10, Affordability: ${city.stats.averages.affordability ?? "n/a"}/10, Walkability: ${city.stats.averages.walkability ?? "n/a"}/10, Cleanliness: ${city.stats.averages.cleanliness ?? "n/a"}/10`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  let excerptBlock = "";
  if (reviewResult.found && Array.isArray(reviewResult.recentReviews)) {
    const excerpts = reviewResult.recentReviews
      .filter((r) => r.comment)
      .slice(0, 4)
      .map((r) => `- "${r.comment.slice(0, 200)}"`)
      .join("\n");
    if (excerpts) excerptBlock = `\nRecent resident comments:\n${excerpts}`;
  }

  const prompt = `Write a 3–4 sentence "City Snapshot" paragraph for ${city.name}, ${city.state}. Use only the data below — do not add general knowledge. Highlight the most notable scores and one or two resident sentiments if available. Be factual, specific, and concise. Do not use headers or bullet points — write plain prose only.\n\n${dataLines}${excerptBlock}`;

  const response = await anthropicClient.messages.create({
    model: AI_MODEL,
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const summary = textBlock?.text?.trim() ?? "";

  return { summary, reviewCount };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a city summary, generating a new one if none exists or if it's stale.
 * Reads the current review count from `city_stats` internally.
 * Falls back to the cached summary on Anthropic API failure rather than throwing.
 * @param {string} cityId
 * @returns {Promise<{ summary: string, generatedAt: string|null, fresh: boolean, stale?: boolean }>}
 */
async function getOrGenerateSummary(cityId) {
  const [cached, statsSnap] = await Promise.all([
    getCachedSummary(cityId),
    db.collection("city_stats").doc(cityId).get(),
  ]);

  const currentReviewCount = statsSnap.exists ? (statsSnap.data()?.reviewCount ?? 0) : 0;

  if (cached && !shouldRegenerate(cached, currentReviewCount)) {
    return {
      summary: cached.summary,
      generatedAt: cached.generatedAt?.toDate?.()?.toISOString() ?? null,
      fresh: false,
    };
  }

  try {
    const { summary, reviewCount } = await generateCitySummary(cityId);
    await saveSummary(cityId, summary, reviewCount);
    return { summary, generatedAt: new Date().toISOString(), fresh: true };
  } catch (err) {
    if (cached) {
      console.warn(`[aiSummaryService] generation failed for ${cityId}, returning stale cache:`, err.message);
      return {
        summary: cached.summary,
        generatedAt: cached.generatedAt?.toDate?.()?.toISOString() ?? null,
        fresh: false,
        stale: true,
      };
    }
    throw err;
  }
}

module.exports = { getOrGenerateSummary, generateCitySummary };
