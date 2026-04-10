/**
 * Anthropic tool definitions for CityInsight AI queries.
 * Each tool maps directly to a function in aiQueryService.js.
 */
const AI_TOOLS = [
  {
    name: "getCity",
    description:
      "Look up a city by name and return its full profile: basic info (name, state, tagline, description, highlights), " +
      "community review stats (overall/safety/affordability/walkability/cleanliness averages, review count, livability score), " +
      "and external metrics (median rent, population, safety score). " +
      "Pass city name as-is (e.g. \"Portland\" or \"Portland, OR\"). " +
      "Returns up to 3 matching cities if the name is ambiguous.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "City name, optionally with state abbreviation (e.g. \"Seattle\", \"Seattle, WA\", \"Los Angeles, CA\").",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "aggregateReviews",
    description:
      "Return detailed review aggregation for a city: average ratings per category, " +
      "total review count, livability score, and up to 8 recent reviewer comments (up to 600 chars each). " +
      "Use this when the user asks about community sentiment, what residents think, or wants qualitative review excerpts.",
    input_schema: {
      type: "object",
      properties: {
        cityName: {
          type: "string",
          description: "City name to look up reviews for (e.g. \"Austin\", \"Austin, TX\").",
        },
      },
      required: ["cityName"],
    },
  },
  {
    name: "compareCities",
    description:
      "Fetch full data (stats, metrics, averages, livability score) for 2–4 cities side by side. " +
      "Use this when the user wants to compare multiple specific cities.",
    input_schema: {
      type: "object",
      properties: {
        cities: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 4,
          description: "Array of 2–4 city names to compare (e.g. [\"Denver, CO\", \"Boulder, CO\", \"Fort Collins, CO\"]).",
        },
      },
      required: ["cities"],
    },
  },
  {
    name: "rankCities",
    description:
      "Return the top N cities ranked by a specific metric, queried directly from the database. " +
      "ALWAYS use this tool (instead of guessing cities with getCity) for broad questions like " +
      "'safest city', 'most affordable city', 'best livability', 'most walkable', 'cleanest', 'most reviewed city', " +
      "'least livable city', 'worst safety', 'least walkable', 'least clean', or any other best/worst ranking question. " +
      "Use order='desc' for best/most/highest (default), order='asc' for worst/least/lowest. " +
      "Supported metrics: livabilityScore, safetyScore, affordability, reviewCount, walkabilityAvg, cleanlinessAvg, overallAvg.",
    input_schema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: ["livabilityScore", "safetyScore", "affordability", "reviewCount", "walkabilityAvg", "cleanlinessAvg", "overallAvg"],
          description:
            "livabilityScore = overall livability (0–100). " +
            "safetyScore = external safety score derived from crime data (0–10). " +
            "affordability = lowest median rent first. " +
            "reviewCount = most community reviews. " +
            "walkabilityAvg = highest resident-rated walkability (1–10). " +
            "cleanlinessAvg = highest resident-rated cleanliness (1–10). " +
            "overallAvg = highest resident-rated overall score (1–10).",
        },
        order: {
          type: "string",
          enum: ["desc", "asc"],
          description:
            "Sort order. 'desc' = highest first (best, most, safest — default). " +
            "'asc' = lowest first (worst, least livable, least safe, cheapest). " +
            "Note: affordability is always cheapest-first regardless of this setting.",
        },
        limit: {
          type: "number",
          description: "How many cities to return (1–10, default 5).",
        },
        state: {
          type: "string",
          description:
            "Optional two-letter US state abbreviation to restrict results (e.g. \"CA\", \"TX\"). " +
            "Omit to rank across all states.",
        },
      },
      required: ["metric"],
    },
  },
  {
    name: "filterCities",
    description:
      "Filter cities by multiple criteria simultaneously and return matches sorted by livability score. " +
      "Use this when the user combines constraints, e.g. 'safest cities under $2000/month', " +
      "'walkable cities with good safety in Texas', or 'clean cities with rent under $1500'. " +
      "All filter fields are optional — only apply the ones the user explicitly mentions.",
    input_schema: {
      type: "object",
      properties: {
        minSafetyScore: {
          type: "number",
          description: "Minimum safety score (0–10), e.g. 8.0 for 'safe cities'.",
        },
        maxMedianRent: {
          type: "number",
          description: "Maximum median monthly rent in dollars, e.g. 2000 for 'under $2000/month'.",
        },
        minLivabilityScore: {
          type: "number",
          description: "Minimum livability score (0–100), e.g. 60.",
        },
        minWalkabilityAvg: {
          type: "number",
          description: "Minimum resident-rated walkability average (1–10), e.g. 7.0 for 'walkable cities'.",
        },
        minCleanlinessAvg: {
          type: "number",
          description: "Minimum resident-rated cleanliness average (1–10), e.g. 7.0 for 'clean cities'.",
        },
        maxAqiValue: {
          type: "number",
          description: "Maximum air quality index (0–500, lower = cleaner air), e.g. 50 for 'good air quality' or 100 for 'moderate air quality'.",
        },
        state: {
          type: "string",
          description: "Optional two-letter US state abbreviation to restrict results (e.g. \"CA\", \"TX\").",
        },
        limit: {
          type: "number",
          description: "How many cities to return (1–10, default 10).",
        },
      },
      required: [],
    },
  },
];

module.exports = { AI_TOOLS };
