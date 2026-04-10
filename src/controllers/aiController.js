const { randomUUID } = require("crypto");
const { admin, db } = require("../config/firebase");
const { AI_ENABLED, NODE_ENV } = require("../config/env");
const { anthropicClient: client, AI_MODEL } = require("../config/anthropic");
const { AI_TOOLS } = require("../lib/aiTools");
const { getCity, aggregateReviews, compareCities, rankCities, filterCities } = require("../services/aiQueryService");
const { fetchAllCityRows } = require("../services/cityService");
const { AppError } = require("../lib/errors");

// ─── City list cache ──────────────────────────────────────────────────────────
// Keeps a sanitized, sorted string list of all cities for injection into the
// system prompt. The 10-minute TTL avoids rebuilding on every request while
// still picking up new cities after a cityService cache invalidation.
// ─────────────────────────────────────────────────────────────────────────────

let cityListCache = { lines: [], loadedAt: 0 };
const CITY_LIST_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Removes characters that could be used for prompt injection before a city
 * name is inserted into the system prompt.
 */
function sanitizeCityLine(raw) {
  return String(raw)
    .replace(/[^\w\s,.()\-]/g, "")
    .slice(0, 100);
}

/**
 * Returns the cached sorted list of "City, ST" strings, refreshing from
 * Firestore when the TTL has elapsed. Sorting guarantees a byte-for-byte
 * identical system prompt prefix on every request so Anthropic's prompt
 * cache reliably hits regardless of the order rows are returned by the DB.
 */
async function getCityList() {
  const cacheIsValid =
    cityListCache.lines.length > 0 &&
    Date.now() - cityListCache.loadedAt < CITY_LIST_CACHE_TTL_MS;
  if (cacheIsValid) return cityListCache.lines;

  const rows = await fetchAllCityRows();
  const lines = rows.map((row) => sanitizeCityLine(`${row.name}, ${row.state}`)).sort();
  cityListCache = { lines, loadedAt: Date.now() };
  return lines;
}

// ─── Intent detection ─────────────────────────────────────────────────────────
// Before entering the agentic loop we try to identify ranking/filter intent so
// the correct tool can be pre-executed. This guarantees the model always
// receives objectively correct data instead of guessing city names itself.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a natural-language query to one of the rankCities metric names, or
 * returns null if the query does not appear to be a ranking question.
 */
function detectRankingMetric(query) {
  const lowerQuery = query.toLowerCase();

  const containsRankingWord = /\b(best|worst|safest|most|highest|lowest|top|least)\b/.test(lowerQuery);
  if (!containsRankingWord) return null;

  if (/\blivab(ility|le)?\b/.test(lowerQuery))                                  return "livabilityScore";
  if (/\b(safe(ty|st)?|unsafe|crime)\b/.test(lowerQuery))                       return "safetyScore";
  if (/\b(afford(able|ability)?|cheap(est)?|rent|expensive|cost)\b/.test(lowerQuery)) return "affordability";
  if (/\b(review(s|ed|count)?|most rated|most ratings)\b/.test(lowerQuery))     return "reviewCount";
  if (/\bwalk(able|ability)\b/.test(lowerQuery))                                return "walkabilityAvg";
  if (/\bclean(est|liness)?\b/.test(lowerQuery))                                return "cleanlinessAvg";
  if (/\b(overall|highest.rated|top.rated)\b/.test(lowerQuery))                 return "overallAvg";

  return null;
}

/**
 * Returns "asc" when the query asks for the worst/least end of a ranking,
 * "desc" otherwise (best/most/highest/top).
 */
function detectRankingOrder(query) {
  const lowerQuery = query.toLowerCase();
  if (/\b(worst|least|lowest|bottom)\b/.test(lowerQuery)) return "asc";
  return "desc";
}

// Full state name → two-letter USPS abbreviation.
const STATE_NAMES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};

// All valid two-letter abbreviations, used for O(1) membership checks below.
const STATE_ABBREVIATIONS = new Set(Object.values(STATE_NAMES));

/**
 * Returns a two-letter state abbreviation if the query clearly mentions a US
 * state, otherwise null.
 *
 * Full state names (e.g. "california") are matched unconditionally.
 * Bare two-letter uppercase tokens are only matched when surrounded by explicit
 * state context — preceded by "in/from/of", followed by "cities/state", or
 * appearing after a comma in a "City, ST" pattern — to avoid false positives on
 * common abbreviations like "AI", "UI", or "ID".
 */
function detectStateFilter(query) {
  const lowerQuery = query.toLowerCase();

  for (const [stateName, abbreviation] of Object.entries(STATE_NAMES)) {
    if (lowerQuery.includes(stateName)) return abbreviation;
  }

  // Require at least one of these context patterns before trusting a two-letter token:
  //   "in TX" / "from TX" / "of TX"   →  group 1
  //   "TX cities" / "TX state"         →  group 2
  //   ", TX"  (city-state pair)         →  group 3
  const abbrevWithContext = query.match(
    /(?:(?:in|from|of)\s+([A-Z]{2})\b|\b([A-Z]{2})\s+(?:cities|state)\b|,\s*([A-Z]{2})\b)/
  );
  if (abbrevWithContext) {
    const token = abbrevWithContext[1] ?? abbrevWithContext[2] ?? abbrevWithContext[3];
    if (STATE_ABBREVIATIONS.has(token)) return token;
  }

  return null;
}

// ─── System prompt ────────────────────────────────────────────────────────────
// Rebuilt per-request so the city list is always current. The cache_control
// flag on the single large text block lets Anthropic cache the prompt prefix
// across requests — cached input tokens cost roughly 10% of normal.
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(cityLines) {
  return [
    {
      type: "text",
      text: `You are CityInsight AI, the built-in assistant for the CityInsight platform — a crowdsourced livability tool where real residents rate US cities on safety, affordability, walkability, and cleanliness.

You have access to the following tools that query live CityInsight data:
- getCity(name): look up a city's full profile (tagline, description, highlights, review stats, external metrics)
- aggregateReviews(cityName): get detailed rating averages and up to 8 recent review excerpts
- compareCities(cities[]): fetch full data for 2–4 cities side by side
- rankCities(metric, limit): return the top N cities ranked by livabilityScore, safetyScore, affordability, reviewCount, walkabilityAvg, cleanlinessAvg, or overallAvg
- filterCities(filters): filter cities by multiple thresholds (safety, rent, livability, walkability, cleanliness) simultaneously

CITIES CURRENTLY IN THE DATABASE (${cityLines.length} total):
${cityLines.join("\n")}

STRICT RULES — never break these:
1. Always call at least one tool before writing your response. Never answer from general knowledge.
2. Never ask the user for clarification. Pick the most reasonable interpretation and act on it immediately.
3. For broad questions ("safest city?", "most affordable?", "best livability?", "most walkable?", "cleanest?", "most reviewed?"), ALWAYS call rankCities with the appropriate metric first. For multi-constraint questions ("safe AND affordable"), use filterCities instead. Never guess city names for these queries.
4. Only use city names from the list above. Do not invent cities.
5. Lead with a direct answer, then back it up with specific numbers from the tool results.
6. Format all responses in Markdown: **bold** city names and key numbers, use bullet or numbered lists for comparisons. Keep it concise and scannable.
7. Ratings are on a 1–10 scale. Livability scores are 0–100. Always include units.
8. If a requested city genuinely isn't in the list, say so in one sentence.
9. If the user asks about anything unrelated to cities or the CityInsight platform, respond in one sentence that you only assist with city data questions.`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

// ─── Tool executor ────────────────────────────────────────────────────────────

/** Dispatches a single tool call from the model to the correct service function. */
async function executeTool(toolName, toolInput) {
  switch (toolName) {
    case "getCity":          return getCity(toolInput.name);
    case "aggregateReviews": return aggregateReviews(toolInput.cityName);
    case "compareCities":    return compareCities(toolInput.cities);
    case "rankCities":       return rankCities(toolInput.metric, toolInput.limit, toolInput.state, toolInput.order);
    case "filterCities":     return filterCities(toolInput);
    default:
      throw new AppError(`Unknown tool: ${toolName}`, { status: 500, code: "UNKNOWN_TOOL" });
  }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/** Returns whether AI features are enabled on this server instance. */
function getAiStatus(_req, res) {
  return res.json({ enabled: AI_ENABLED });
}

// ─── Session helpers ──────────────────────────────────────────────────────────

const MAX_SESSION_MESSAGES = 40;   // 20 user + 20 assistant turns
const MAX_SESSION_ID_LENGTH = 36;  // standard UUID length
const MAX_AGENTIC_TURNS = 8;
const MAX_QUERY_LENGTH = 1000;

/**
 * Fetches the persisted message history for a session from Firestore.
 * Returns an empty array when the session does not exist or on read error,
 * so callers can treat missing and new sessions identically.
 */
async function loadSessionMessages(sessionId) {
  try {
    const sessionDoc = await db.collection("ai_sessions").doc(sessionId).get();
    if (!sessionDoc.exists) return [];
    return sessionDoc.data().messages ?? [];
  } catch (err) {
    console.error("[ai_sessions] load failed:", err.message);
    return [];
  }
}

/**
 * Writes the message history back to Firestore, trimming oldest turn-pairs
 * until the array fits within MAX_SESSION_MESSAGES. Runs the write without
 * blocking the response — callers should `.catch()` the returned promise.
 */
async function saveSessionMessages(sessionId, messages, userId) {
  let history = messages;
  while (history.length > MAX_SESSION_MESSAGES && history.length >= 2) {
    history = history.slice(2); // drop the oldest user+assistant pair
  }
  await db
    .collection("ai_sessions")
    .doc(sessionId)
    .set(
      {
        messages: history,
        userId: userId ?? null,
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        turnCount: admin.firestore.FieldValue.increment(1),
      },
      { merge: true },
    );
}

// ─── Execution paths ──────────────────────────────────────────────────────────
// runAiQuery delegates to one of two clearly separated paths:
//
//   executePreRanking  — fast path for ranking questions: pre-fetches the
//                        correct data, then asks Claude to format it only.
//   executeAgenticLoop — general path: iterates model↔tool calls until the
//                        model produces a final text response.
//
// Both functions mutate apiMessages and toolCallTrace in place so the caller
// can inspect the full conversation state after either path completes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-execution path for ranking queries.
 *
 * Detects whether the query asks for a ranked list, calls rankCities directly,
 * injects the result as a synthetic tool_use / tool_result pair into apiMessages
 * (never into sessionMessages), then asks Claude to format the data with
 * tool_choice: none so it cannot re-derive the ranking on its own.
 *
 * Returns the formatted response string on success. Returns null when:
 *   - the query is not a recognizable ranking question, or
 *   - rankCities itself returned an error (the agentic loop will handle recovery).
 */
async function executePreRanking(userQuery, apiMessages, toolCallTrace, toolResultCache, systemPrompt) {
  const rankingMetric = detectRankingMetric(userQuery);
  if (!rankingMetric) return null;

  // A stable synthetic ID is fine here because this message pair is never
  // persisted to session history and lives only in apiMessages for this request.
  const syntheticMsgId = "pre_rank_0";
  const stateFilter = detectStateFilter(userQuery);
  const rankOrder = detectRankingOrder(userQuery);
  const rankInput = { metric: rankingMetric, limit: 10, order: rankOrder, ...(stateFilter ? { state: stateFilter } : {}) };

  let rankResult;
  try {
    rankResult = await rankCities(rankInput.metric, rankInput.limit, stateFilter, rankOrder);
  } catch (err) {
    rankResult = { error: err.message ?? "rankCities failed" };
  }

  // Seed the dedup cache so the agentic loop won't re-execute the same call
  // if control falls through after an error.
  toolResultCache.set(`rankCities:${JSON.stringify(rankInput)}`, rankResult);
  toolCallTrace.push({ tool: "rankCities", input: rankInput, result: rankResult });

  // Synthetic pairs go into apiMessages only — sessionMessages stays clean so
  // future turns do not replay internal tool scaffolding.
  apiMessages.push({
    role: "assistant",
    content: [{ type: "tool_use", id: syntheticMsgId, name: "rankCities", input: rankInput }],
  });
  apiMessages.push({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: syntheticMsgId, content: JSON.stringify(rankResult) }],
  });

  if (rankResult.error) return null; // fall through to the agentic loop

  const formattingResponse = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    tools: AI_TOOLS,
    tool_choice: { type: "none" },
    messages: apiMessages,
  });

  const textBlock = formattingResponse.content.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

/**
 * General agentic loop path.
 *
 * Iterates up to MAX_TURNS rounds of model→tool→model until the model
 * signals end_turn (final answer produced) or turns are exhausted.
 * Tool calls with identical name+input within the same invocation are
 * deduplicated via toolResultCache to avoid redundant service calls and billing.
 *
 * Returns the final text response, or an empty string if all turns are used up.
 */
async function executeAgenticLoop(apiMessages, toolCallTrace, toolResultCache, systemPrompt) {
  for (let turn = 0; turn < MAX_AGENTIC_TURNS; turn++) {
    const modelResponse = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools: AI_TOOLS,
      messages: apiMessages,
    });

    if (modelResponse.stop_reason === "end_turn") {
      const textBlock = modelResponse.content.find((block) => block.type === "text");
      return textBlock?.text ?? "";
    }

    if (modelResponse.stop_reason === "tool_use") {
      apiMessages.push({ role: "assistant", content: modelResponse.content });

      const requestedToolCalls = modelResponse.content.filter((block) => block.type === "tool_use");

      // Execute all tool calls for this turn in parallel. Return the cached result
      // immediately when the same tool+input has already been called this session.
      const toolCallOutcomes = await Promise.all(
        requestedToolCalls.map(async (toolCall) => {
          const cacheKey = `${toolCall.name}:${JSON.stringify(toolCall.input)}`;
          let result;
          let toolError = null;

          if (toolResultCache.has(cacheKey)) {
            result = toolResultCache.get(cacheKey);
          } else {
            try {
              result = await executeTool(toolCall.name, toolCall.input);
              toolResultCache.set(cacheKey, result);
            } catch (err) {
              toolError = err.message ?? "Tool execution failed";
              result = { error: toolError };
            }
          }

          return { toolCall, result, toolError };
        }),
      );

      for (const { toolCall, result, toolError } of toolCallOutcomes) {
        toolCallTrace.push({
          tool: toolCall.name,
          input: toolCall.input,
          result,
          ...(toolError ? { error: toolError } : {}),
        });
      }

      const toolResultMessages = toolCallOutcomes.map(({ toolCall, result }) => ({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: JSON.stringify(result),
      }));

      apiMessages.push({ role: "user", content: toolResultMessages });
      continue;
    }

    // max_tokens or any other unexpected stop reason — return whatever text exists.
    const textBlock = modelResponse.content.find((block) => block.type === "text");
    return textBlock?.text ?? "";
  }

  return ""; // all turns exhausted without an end_turn signal
}

// ─── Main query handler ───────────────────────────────────────────────────────

/**
 * POST /ai/query
 *
 * Runs an agentic tool-use session for the given user query. Supports
 * multi-turn conversations via sessionId — pass the sessionId returned by
 * a previous call to continue the same thread.
 *
 * Persists clean session history to ai_sessions and a full audit record
 * (including tool call trace) to ai_logs, both fire-and-forget.
 *
 * Response: { response, toolCallTrace?, sessionId }
 * toolCallTrace is omitted in production to avoid leaking internal data shapes.
 */
async function runAiQuery(req, res, next) {
  try {
    if (!AI_ENABLED) {
      return res.status(503).json({ error: { code: "AI_DISABLED", message: "AI features are currently disabled." } });
    }

    const rawQuery = String(req.body?.query ?? "").trim();
    if (!rawQuery) {
      return res.status(400).json({ error: { code: "MISSING_QUERY", message: "query is required" } });
    }
    if (rawQuery.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({ error: { code: "QUERY_TOO_LONG", message: `query must be <= ${MAX_QUERY_LENGTH} characters` } });
    }

    // Strip ASCII control characters (0x00–0x1F, 0x7F) before the query enters
    // message history. Control sequences are a prompt injection surface and have
    // no legitimate use in a natural-language city query.
    const userQuery = rawQuery.replace(/[\x00-\x1F\x7F]/g, "");

    // Resolve the session: continue an existing thread or create a fresh one.
    const requestedSessionId = String(req.body?.sessionId ?? "").trim();
    if (requestedSessionId && !/^[0-9a-f-]{36}$/.test(requestedSessionId)) {
      return res.status(400).json({ error: { code: "INVALID_SESSION_ID", message: "Invalid sessionId" } });
    }
    const sessionId = requestedSessionId || randomUUID();
    const priorHistory = requestedSessionId ? await loadSessionMessages(sessionId) : [];

    const cityLines = await getCityList();
    const systemPrompt = buildSystemPrompt(cityLines);

    // Two separate message arrays serve distinct purposes:
    //
    //   sessionMessages — the canonical conversation history stored in Firestore.
    //                     Contains only real user text and final assistant text
    //                     responses. Replayed as-is on the next turn.
    //
    //   apiMessages     — the working copy sent to the Anthropic API. Starts as a
    //                     clone of sessionMessages and may grow to include synthetic
    //                     tool_use/tool_result pairs injected by executePreRanking.
    //                     Never persisted; discarded after this request.
    const sessionMessages = [...priorHistory, { role: "user", content: userQuery }];
    const apiMessages = [...sessionMessages];

    const toolCallTrace = [];
    const toolResultCache = new Map(); // dedup key: "toolName:JSON(input)"

    // Attempt the fast pre-execution path first; fall back to the full agentic
    // loop if the query isn't a ranking question or if pre-execution fails.
    //
    // Snapshot apiMessages before pre-ranking so we can discard any synthetic
    // tool_use/tool_result pairs injected by executePreRanking on failure.
    // Without this, a failed pre-ranking contaminates the agentic loop with
    // tool calls the model never made, which can cause hallucinations.
    const apiMessagesSnapshot = [...apiMessages];
    let finalResponse = await executePreRanking(userQuery, apiMessages, toolCallTrace, toolResultCache, systemPrompt);
    if (finalResponse === null) {
      // Restore clean state so the agentic loop doesn't inherit synthetic pairs.
      apiMessages.length = 0;
      apiMessages.push(...apiMessagesSnapshot);
      finalResponse = await executeAgenticLoop(apiMessages, toolCallTrace, toolResultCache, systemPrompt);
    }
    if (!finalResponse) {
      finalResponse =
        "I wasn't able to complete this query within the allowed number of steps. Please try rephrasing or narrowing your question.";
    }

    // Persist only the clean session history — no synthetic tool scaffolding.
    saveSessionMessages(
      sessionId,
      [...sessionMessages, { role: "assistant", content: finalResponse }],
      req.user?.sub,
    ).catch((err) => console.error("[ai_sessions] write failed:", err.message));

    // Full audit log including tool call trace for observability.
    db.collection("ai_logs")
      .add({
        query: rawQuery,
        response: finalResponse,
        toolCallTrace,
        sessionId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      .catch((err) => console.error("[ai_logs] write failed:", err.message));

    // Omit toolCallTrace from the client payload in production — it contains
    // internal tool names, raw inputs, and Firestore data shapes.
    const isProd = NODE_ENV === "production";
    return res.json({
      response: finalResponse,
      ...(isProd ? {} : { toolCallTrace }),
      sessionId,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /ai/session/:sessionId
 *
 * Returns the stored message history for a session. Access is granted when
 * the session is anonymous (userId: null) or belongs to the authenticated user.
 */
async function getAiSession(req, res, next) {
  try {
    const { sessionId } = req.params;
    if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) {
      return res.status(400).json({ error: { code: "INVALID_SESSION_ID", message: "Invalid sessionId" } });
    }

    const sessionDoc = await db.collection("ai_sessions").doc(sessionId).get();
    if (!sessionDoc.exists) {
      return res.status(404).json({ error: { code: "SESSION_NOT_FOUND", message: "Session not found" } });
    }

    const sessionData = sessionDoc.data();
    const requestingUserId = req.user?.sub ?? null;
    if (sessionData.userId && sessionData.userId !== requestingUserId) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Session belongs to another user" } });
    }

    return res.json({ sessionId, messages: sessionData.messages ?? [] });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAiStatus, runAiQuery, getAiSession };
