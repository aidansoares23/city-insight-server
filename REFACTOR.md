# Backend Refactor Plan

## Summary

The CityInsight backend is in good structural shape overall: it has a real service layer, a centralized error class, functional rate limiting, proper Firestore transactions for review mutations, and a surprisingly thorough test suite for a portfolio project. The most impactful problem areas are (1) significant duplication between the two seed scripts, (2) a handful of controller-level Firestore reads that belong in the service layer, (3) several magic constants that are repeated verbatim across files, (4) missing test coverage for the AI controller and reaction service, and (5) a stale string label in `attractions.js` that still says "Foursquare" after the underlying API was replaced with OpenStreetMap Overpass. No critical security vulnerabilities were found, but a few low-severity issues are worth cleaning up.

---

## Issues by Category

### 1. Duplication / DRY Violations

**ISSUE-01**
- File: `src/scripts/devInit.js` (lines 167–175, 222–295) and `src/scripts/seedMissingReviews.js` (lines 27–132)
- Category: Duplication
- Description: Both seed scripts define identical `makeReviewId`, `chunk`, `clamp`, `generateRatings`, `pick`, city review lines, `generateComment`, and `USERS` arrays. The only difference is that `devInit.js` resets all cities while `seedMissingReviews.js` only seeds cities missing reviews.
- Suggested fix: Extract the shared seed utilities (`makeReviewId`, `chunk`, `clamp`, `generateRatings`, `generateComment`, `USERS`, `CITY_BASE_RATINGS`, `CITY_REVIEW_LINES`) into `src/scripts/lib/seedUtils.js` and import them in both scripts.

**ISSUE-02**
- File: `src/scripts/devInit.js` (lines 322–327) and `src/scripts/seedMissingReviews.js` (lines 27–32)
- Category: Duplication
- Description: `devInit.js` reimplements `toNumOrNull` and `clamp0to100` inline (lines 322–329) rather than importing from `src/lib/numbers.js`, where both functions already exist.
- Suggested fix: Replace the inline definitions with `const { toNumOrNull, clamp0to100 } = require("../lib/numbers")`.

**ISSUE-03**
- File: `src/scripts/tasks/safety.js` (lines 10–17) and `src/scripts/tasks/safetyApi.js` (lines 7–12)
- Category: Duplication
- Description: Both safety task files define the same five calibration constants (`YEARS_TO_AVG = 3`, `WEIGHT_VIOLENT = 3`, `WEIGHT_PROPERTY = 1`, `RATE_AT_ZERO = 2500`) and the same `computeSafetyScore(FromIndex)` formula (identical logic, different function names).
- Suggested fix: Move the shared constants and the score formula into a shared `src/scripts/lib/safetyCalibration.js` module and import in both tasks.

**ISSUE-04**
- File: `src/middleware/requireAuth.js` (lines 56–82) and `src/middleware/optionalAuth.js` (lines 12–23)
- Category: Duplication
- Description: Both middleware files duplicate the dev-bypass block: reading `DEV_AUTH_BYPASS`, checking `isLocalDevRequest`, and extracting `x-dev-user`. The only behavioral difference is that `optionalAuth` does not error on a missing header.
- Suggested fix: Extract the bypass logic into a private `resolveDevBypassUser(req)` helper in a shared `src/middleware/authHelpers.js` that returns `{ sub, isDevBypass }` or `null`, then call it from both middlewares.

**ISSUE-05**
- File: `src/scripts/tasks/airQuality.js` (lines 44–45, 52–53, 73) and throughout pipeline scripts
- Category: Duplication
- Description: `await new Promise((r) => setTimeout(r, SLEEP_MS))` is repeated three times within a single 80-line function in `airQuality.js` and also duplicated in `attractions.js` as a named `sleep()` helper.
- Suggested fix: Import the `sleep` function from a shared `src/scripts/lib/sleep.js` utility instead of re-declaring it.

---

### 2. Dead Code

**ISSUE-06**
- File: `src/scripts/tasks/summaries.js` (line 5)
- Category: Dead code
- Description: `const MODEL = "claude-haiku-4-5-20251001"` is declared at the top of `summaries.js` but is only used in the `set()` call at line 49 to write `model: MODEL` to Firestore. The actual generation model is decided inside `aiSummaryService.js`, which also has its own identical `MODEL` constant. This value in `summaries.js` is a stale copy that will silently diverge if the model is ever updated in the service.
- Suggested fix: Remove the `MODEL` constant from `summaries.js` and instead import and re-use the value returned by `generateCitySummary` (which already returns the model string as part of the result) or expose a `SUMMARY_MODEL` export from `aiSummaryService.js`.

**ISSUE-07**
- File: `src/scripts/tasks/attractions.js` (line 3)
- Category: Dead code
- Description: `const admin = require("firebase-admin")` is imported directly in `attractions.js` instead of using the already-initialized `admin` from `src/config/firebase.js`. This causes a second `require` of the `firebase-admin` package that returns the same singleton but bypasses the initialized app guard.
- Suggested fix: Change to `const { admin } = require("../../config/firebase")` to be consistent with every other task file.

**ISSUE-08**
- File: `src/services/reactionService.js` (lines 53–65)
- Category: Dead code
- Description: `getReactionCountsForReview` (singular) is exported but never imported or called anywhere in the application — `getReactionCountsForReviews` (plural) is the function actually used in `reviewController.js`. The singular function performs a per-review query that is strictly less efficient than the batch function.
- Suggested fix: Remove `getReactionCountsForReview` from the service and from the `module.exports`.

---

### 3. Naming

**ISSUE-09**
- File: `src/scripts/tasks/attractions.js` (line 19)
- Category: Naming
- Description: The task header comment says `"=== attractions (Foursquare Places API) ==="` and the function JSDoc says `"Foursquare Places API"` on line 17, but the actual implementation uses the OpenStreetMap Overpass API via `foursquareService.js`. This is misleading to any future contributor.
- Suggested fix: Update the log string and JSDoc to say `"Overpass (OpenStreetMap)"` to match the implementation. Consider also renaming `foursquareService.js` to `overpassService.js`.

**ISSUE-10**
- File: `src/controllers/cityController.js` (line 97–98)
- Category: Naming
- Description: The variable `raw` is used for the weights object (`const raw = req.body?.weights ?? {}`) and also for the state filter (`const stateFilter = raw.state`), creating confusion since `raw` conventionally implies an unprocessed scalar, not the entire request body.
- Suggested fix: Rename `raw` to `body` or `weightInput` to clarify that it holds the entire weights payload.

**ISSUE-11**
- File: `src/controllers/aiController.js` (line 472)
- Category: Naming
- Description: `const isProd = process.env.NODE_ENV === "production"` reads `process.env` directly instead of using the already-imported `AI_ENABLED` / `NODE_ENV` from `src/config/env.js`, creating an inconsistency with the rest of the file where `AI_ENABLED` is imported from config.
- Suggested fix: Replace with `const isProd = NODE_ENV === "production"` using the already-imported `NODE_ENV` constant.

**ISSUE-12**
- File: `src/services/aiQueryService.js` (line 48)
- Category: Naming
- Description: `nameToSlugGuess` is a reasonable internal name, but the logic strips accents/special characters in a way that is not actually slug-compatible for all inputs (e.g. "St. Louis" produces `"st-louis"` which is fine, but the name implies it is only a guess). The function is not the issue, but the comment on line 24 says `"Portland, OR" -> "portland-or"` which contradicts the actual output `"portland--or"` when the comma replacement and space replacement chain produces a double dash before the `-+` dedup regex catches it. This is a logic concern, not just naming.
- Suggested fix: Confirm the actual slug output for `"Portland, OR"` matches city slugs in the database. If the regex chain produces `"portland-or"` correctly (the `-+` → `-` dedup at the end handles it), add a unit test to assert this. If it produces `"portland--or"`, fix the replace order.

---

### 4. Controller Hygiene

**ISSUE-13**
- File: `src/controllers/cityController.js` (lines 65–67)
- Category: Controller hygiene
- Description: `getCitySummary` performs a direct Firestore read (`db.collection("city_stats").doc(slug).get()`) inside the controller to retrieve `reviewCount` before calling `getOrGenerateSummary`. This is business logic that belongs in the service layer.
- Suggested fix: Move the `city_stats` read into `aiSummaryService.getOrGenerateSummary` so the controller only calls the service and returns the result. The controller should not know about `city_stats`.

**ISSUE-14**
- File: `src/controllers/cityController.js` (lines 84–162)
- Category: Controller hygiene
- Description: `recommendCities` is the longest function in any controller at 80+ lines. It performs weight normalization, fetches from `cityService`, does a `db.getAll()` batch read, computes normalized scores, and sorts — all inside the controller. This is a full recommendation algorithm that belongs in a service function.
- Suggested fix: Extract the entire function body into `cityService.recommendCities({ weights, stateFilter })` and reduce the controller to a thin wrapper that parses the request, calls the service, and returns the result.

**ISSUE-15**
- File: `src/controllers/reactionController.js` (lines 30–51)
- Category: Controller hygiene
- Description: `upsertReaction` fetches the review document directly from Firestore (`db.collection("reviews").doc(reviewId).get()`) inside the controller to validate city ownership and block self-reactions. This is business-logic validation that belongs in `reactionService`.
- Suggested fix: Move the review existence check and ownership validation into `reactionService.upsertReaction`, which can throw appropriate `AppError` instances (404, 403), and let the controller only call the service.

**ISSUE-16**
- File: `src/controllers/authController.js` (lines 33–37)
- Category: Controller hygiene
- Description: `login` checks for `process.env.SESSION_JWT_SECRET` directly at runtime instead of using the `SESSION_JWT_SECRET` constant already imported from `src/config/env.js`. The env module already validates this at startup and throws in production if missing, making the runtime check redundant.
- Suggested fix: Remove the `process.env.SESSION_JWT_SECRET` check from `login` (and use `SESSION_JWT_SECRET` from env for the `jwt.sign` call) since startup-time validation already guarantees its presence in production.

**ISSUE-17**
- File: `src/controllers/aiController.js` (line 289)
- Category: Controller hygiene — magic constant
- Description: `"claude-haiku-4-5-20251001"` is hardcoded in two places: `aiController.js` line 289 (inside `executePreRanking`) and `aiController.js` line 315 (inside `executeAgenticLoop`). The same string is also in `aiSummaryService.js` line 5.
- Suggested fix: Define `const AI_MODEL = "claude-haiku-4-5-20251001"` once in `src/config/anthropic.js` and export it, then import it wherever the model string is needed.

**ISSUE-18**
- File: `src/controllers/aiController.js` (line 409)
- Category: Controller hygiene — magic constant
- Description: The query length limit `1000` is hardcoded in `runAiQuery` with no named constant.
- Suggested fix: Add `const MAX_QUERY_LENGTH = 1000` at the top of the file near the other constants (`MAX_SESSION_MESSAGES`, `MAX_SESSION_ID_LENGTH`).

---

### 5. Error Handling

**ISSUE-19**
- File: `src/controllers/aiController.js` (lines 199–201)
- Category: Error handling
- Description: `loadSessionMessages` silently swallows all errors by returning `[]`. If Firestore is unavailable, the session history is silently lost and the AI receives no prior context, which looks like a fresh conversation to the user. The error is never logged.
- Suggested fix: Add `console.error("[ai_sessions] load failed:", err.message)` in the catch block so transient Firestore errors are at least observable in logs, even though the empty-array fallback is the right behavioral choice.

**ISSUE-20**
- File: `src/services/aiSummaryService.js` (lines 121–136)
- Category: Error handling
- Description: `getOrGenerateSummary` calls `generateCitySummary` without a try/catch. If the Anthropic API fails mid-request (e.g. rate limit), the error propagates all the way to the HTTP response as an unhandled 500, and the existing cached summary is not returned as a fallback.
- Suggested fix: Wrap the `generateCitySummary` call in a try/catch; on failure, if a `cached` summary exists, log a warning and return the stale cached version with `{ fresh: false, stale: true }` rather than throwing.

**ISSUE-21**
- File: `src/controllers/cityController.js` (line 98) and `src/services/cityService.js` (line 104)
- Category: Error handling
- Description: `db.getAll(...rows.map(...))` in `recommendCities` (controller) will throw if `rows` is empty because `db.getAll()` requires at least one argument. There is no guard for the empty-rows case.
- Suggested fix: Add `if (rows.length === 0) return res.json({ cities: [] })` before the `db.getAll()` call.

**ISSUE-22**
- File: `src/services/meService.js` (line 197)
- Category: Error handling
- Description: `updateProfile` calls `ref.get()` after `ref.set()` to return the updated user document. If the second `get()` fails, the function throws a raw Firestore error without an `AppError` wrapper, producing an inconsistent 500 response without a machine-readable `code`.
- Suggested fix: Wrap in try/catch or restructure to return the known `{ displayName: name, displayNameCustomized: true }` without a re-read when freshness is not critical.

---

### 6. AI / Agentic Layer

**ISSUE-23**
- File: `src/controllers/aiController.js` (lines 435–436)
- Category: AI/agentic — session contamination
- Description: `sessionMessages` is initialized as `[...priorHistory, { role: "user", content: userQuery }]` and `apiMessages` as `[...sessionMessages]`. When `executePreRanking` injects synthetic `tool_use`/`tool_result` pairs into `apiMessages`, those pairs are correctly not persisted. However, if `executePreRanking` returns `null` (error path), control falls through to `executeAgenticLoop` which receives `apiMessages` already containing the synthetic pair at indices `[-2]` and `[-1]`. The model therefore sees a tool call it never made as its own prior output, which can cause hallucinations on the retry.
- Suggested fix: When `executePreRanking` returns `null` due to an error (not because the query was non-ranking), reset `apiMessages` to `[...sessionMessages]` before calling `executeAgenticLoop`, or pass a snapshot of `apiMessages` to `executePreRanking` and discard mutations on failure.

**ISSUE-24**
- File: `src/controllers/aiController.js` (lines 57–72)
- Category: AI/agentic — regex false positives
- Description: `detectRankingMetric` matches `\b(best|worst|safest|most|highest|lowest|top|which)\b` as the gating condition. The word "which" will trigger the ranking path for queries like "which neighborhoods are safe in Austin?" or "which city has better walkability, Portland or Denver?" — neither of which should invoke `rankCities` as a pre-execution step.
- Suggested fix: Remove `which` from the ranking-word gate. It is too general. Questions containing "which" that are genuinely ranking questions will still be handled correctly by the agentic loop.

**ISSUE-25**
- File: `src/controllers/aiController.js` (line 418–419)
- Category: AI/agentic — session ID validation
- Description: `sessionId` is accepted if `requestedSessionId` is any non-empty string up to 36 characters. Non-UUID strings (e.g. `"../admin"`, `"<script>"`) are accepted as Firestore document IDs. Firestore will accept them, but it is unexpected input that could produce confusing audit logs.
- Suggested fix: Add a UUID format check: `if (requestedSessionId && !/^[0-9a-f-]{36}$/.test(requestedSessionId))` return a 400 with `INVALID_SESSION_ID`. This already exists in `getAiSession` but is missing from `runAiQuery`.

**ISSUE-26**
- File: `src/controllers/aiController.js` (lines 186–187)
- Category: AI/agentic — magic constants
- Description: `MAX_SESSION_MESSAGES = 40` and `MAX_SESSION_ID_LENGTH = 36` are defined as module-level constants, which is correct. However, `MAX_TURNS = 8` in `executeAgenticLoop` (line 311) is a local constant buried inside a function, not defined alongside the other limits at the top of the file.
- Suggested fix: Hoist `const MAX_AGENTIC_TURNS = 8` to the module-level constants block alongside `MAX_SESSION_MESSAGES`.

**ISSUE-27**
- File: `src/controllers/aiController.js` (line 472) — confirmed fixed
- Category: AI/agentic — exposed tool traces
- Description: Tool call traces (raw tool names, inputs, and Firestore data shapes) are correctly omitted in production via `isProd` check. This known issue has been addressed.
- Note: No action needed. Verified as resolved.

**ISSUE-28**
- File: `src/controllers/aiController.js` (lines 16–44) — confirmed fixed
- Category: AI/agentic — cache instability
- Description: The city list cache correctly sorts lines before injection (`lines.sort()`) to produce a stable, byte-identical system prompt prefix that enables Anthropic prompt cache hits. This known issue has been addressed.
- Note: No action needed. Verified as resolved.

---

### 7. Data Access Patterns

**ISSUE-29**
- File: `src/controllers/cityController.js` (lines 103–104)
- Category: Data access
- Description: `db.getAll(...rows.map((r) => db.collection("city_stats").doc(r.slug ?? r.id)))` inside `recommendCities` performs a batch read that duplicates the work already done by `cityService.fetchAllCityRows()` at line 98, which already fetched and merged stats data into each row. The `walkabilityAvg` and `cleanlinessAvg` averages used by the recommender are already in each `row` object returned by `fetchAllCityRows`.
- Suggested fix: Replace the `db.getAll()` call and `computeAveragesFromStats` logic with direct access to `row.walkabilityAvg` and `row.cleanlinessAvg`, which are already populated. This eliminates the secondary Firestore batch read entirely.

**ISSUE-30**
- File: `src/scripts/tasks/safety.js` (line 176) and loop body
- Category: Data access
- Description: `getPopulation(cityId)` performs a `city_metrics` Firestore read for every CSV file, sequentially, inside the loop. For 50+ cities this is 50+ serial reads.
- Suggested fix: Batch-read all city metrics with a single `db.getAll()` call before the loop and build a `Map<cityId, population>` for O(1) lookups inside the loop.

**ISSUE-31**
- File: `src/scripts/tasks/summaries.js` (line 30)
- Category: Data access
- Description: In the main loop, `db.collection("city_summaries").doc(city.id).get()` is called sequentially for every city to check for existing summaries. For large city sets this is N serial reads before any generation begins.
- Suggested fix: Batch-fetch all city summary docs with `db.getAll(...cityDocs.map(...))` before the loop and check the results in memory.

---

### 8. Security

**ISSUE-32**
- File: `src/controllers/authController.js` (line 33)
- Category: Security — minor
- Description: When `SESSION_JWT_SECRET` is missing, the controller returns a `500 SERVER_MISCONFIG` response that explicitly names the missing env var. In production, env var names in API responses are a minor information leak.
- Suggested fix: Return a generic `"Server configuration error"` message. The specific missing var should only appear in server logs.

**ISSUE-33**
- File: `src/app.js` (lines 25–28)
- Category: Security — minor
- Description: The `CLIENT_ORIGINS` env var is read directly from `process.env` in `app.js` rather than from `src/config/env.js`, making it the only config value that bypasses the centralized env validation module. There is no startup warning if it is missing (it defaults silently to `localhost:5173`).
- Suggested fix: Move `CLIENT_ORIGINS` into `src/config/env.js` with a startup `console.warn` when not set in production, and export it for use in `app.js`.

**ISSUE-34**
- File: `src/services/fbiService.js` (line 17)
- Category: Security
- Description: `FBI_API_KEY` is appended as a URL query parameter (`?API_KEY=${FBI_API_KEY}`). API keys in query parameters appear in server access logs, browser history, and request traces.
- Suggested fix: Move the key to a request header: `headers: { "X-API-Key": FBI_API_KEY }` — check the FBI CDE API docs to confirm header-based auth is supported.

---

### 9. Readability

**ISSUE-35**
- File: `src/controllers/cityController.js` (lines 82–163)
- Category: Readability
- Description: `recommendCities` is 80+ lines and contains three distinct conceptual phases: (1) weight parsing, (2) data fetching, (3) scoring and sorting. Each phase is long enough to deserve its own named function or at minimum a comment block. Currently there is one comment (`// Normalise each signal to 0–1`) in the middle of the scoring phase.
- Suggested fix: Add phase-level comments (`// Phase 1: Parse and normalize weights`, `// Phase 2: Fetch city data`, `// Phase 3: Score and rank`) as a minimum. Ideally extract as a service function (see ISSUE-14).

**ISSUE-36**
- File: `src/services/reviewService.js` (lines 32–140)
- Category: Readability
- Description: `upsertMyReviewForCity` is 108 lines with a deeply nested `runTransaction` callback. The transaction reads (lines 49–68), delta math (lines 72–86), and write construction (lines 96–128) are all inlined. This makes the function hard to unit-test in isolation.
- Suggested fix: Extract the delta-math logic (`computeStatsDelta(prevStats, newRatings, isNew)`) into a standalone pure function that can be tested without a transaction. The transaction callback then only reads, computes, and writes.

**ISSUE-37**
- File: `src/scripts/devInit.js` (lines 389–528)
- Category: Readability
- Description: `main()` is 140 lines and mixes Firestore batching, seeding logic, and step orchestration. Each numbered step (wipe, cities, users, reviews, metrics, stats) could be its own async function with a clear name.
- Suggested fix: Extract each step into its own named function (`seedCities`, `seedUsers`, `seedReviews`, `syncManualMetrics`, `recomputeStats`) and make `main` an orchestrator that calls them in sequence.

**ISSUE-38**
- File: `src/lib/slugs.js` (lines 5–11)
- Category: Readability
- Description: `censusNameToSlug` is only used for California-specific seeding (it hard-codes `"-ca"` suffix) but is exported alongside the more general `censusNameToStateSlug`. This creates confusion about which function to use for new states.
- Suggested fix: Mark `censusNameToSlug` as `@deprecated` in its JSDoc and note that `censusNameToStateSlug` is the preferred function for all states.

---

### 10. Test Coverage

**ISSUE-39**
- File: `test/` (no file covers `aiController.js`)
- Category: Test coverage
- Description: `aiController.js` has zero test coverage — no tests for `detectRankingMetric`, `detectStateFilter`, `sanitizeCityLine`, `getCityList` caching, `executePreRanking`, or `executeAgenticLoop`. These contain the most complex control flow in the entire codebase.
- Suggested fix: Add `test/controllers.aiController.test.js` with unit tests for at least `detectRankingMetric` (various query strings), `detectStateFilter` (full state names, abbreviations, false-positive guard), and `sanitizeCityLine` (special characters stripped, length capped). Mock the Anthropic client for agentic loop tests.

**ISSUE-40**
- File: `test/` (no file covers `reactionService.js` or `reactionController.js`)
- Category: Test coverage
- Description: The reaction system (`upsertReaction`, `deleteReaction`, `getReactionCountsForReviews`, `getMyReactionsForReviews`) has no tests. The chunking logic in `getReactionCountsForReviews` (30-item Firestore `in` limit) is a non-trivial edge case.
- Suggested fix: Add `test/services.reactionService.test.js` covering: upsert creates/replaces, delete is idempotent, `getReactionCountsForReviews` with >30 IDs chunks correctly, and `getMyReactionsForReviews` returns correct type map.

**ISSUE-41**
- File: `test/app.smoke.test.js` (line 289)
- Category: Test coverage — weak assertion
- Description: The CSRF test at line 289 asserts `response.status === 401 || response.status === 403` — an OR assertion that will pass even if the wrong status code is returned for the wrong reason. The test comment acknowledges the ambiguity.
- Suggested fix: Split into two separate tests: one for the unauthenticated case (no `x-dev-user`, expect 401) and one specifically testing that a non-bypass-mode request with a missing CSRF header returns 403.

**ISSUE-42**
- File: `test/` (no file covers `aiSummaryService.js`, `aiQueryService.js`, `cityController.recommendCities`)
- Category: Test coverage
- Description: The AI summary service (`shouldRegenerate`, `generateCitySummary`), the AI query service (`rankCities`, `filterCities`, `getCity` name-matching logic), and the `recommendCities` controller weight-normalization logic all have zero test coverage.
- Suggested fix: Add `test/services.aiQueryService.test.js` covering at minimum: `rankCities` metric sorting (all 7 metrics), `filterCities` threshold filtering, and `getCity` score-based name matching. Add `test/services.aiSummaryService.test.js` covering `shouldRegenerate` staleness logic.

**ISSUE-43**
- File: `test/services.cityService.test.js` (entire file)
- Category: Test coverage — weak mock
- Description: The `cityService` test uses a `getAllCallCount` hack that alternates between returning `statsSnaps` and `metricsSnaps` based on call parity. This is fragile: if `fetchAllCityRows` ever calls `db.getAll()` a different number of times, tests will silently receive the wrong data without failing on the mock mismatch.
- Suggested fix: Replace the call-count hack with a mock that inspects the ref paths to determine which collection is being queried (e.g. check if the first ref's path contains `city_stats` or `city_metrics`).

---

## Prioritized Action List

### P1 — Fix now (high impact, low regression risk)

| # | File | Description | Effort |
|---|------|-------------|--------|
| P1-01 | `src/controllers/aiController.js:472` | Replace `process.env.NODE_ENV` with already-imported `NODE_ENV` constant (ISSUE-11) | Small |
| P1-02 | `src/controllers/aiController.js:311` | Hoist `MAX_TURNS = 8` to module-level constant block (ISSUE-26) | Small |
| P1-03 | `src/controllers/aiController.js:289,315` / `src/config/anthropic.js` | Extract `"claude-haiku-4-5-20251001"` into a named `AI_MODEL` export (ISSUE-17) | Small |
| P1-04 | `src/controllers/aiController.js:409` | Add `const MAX_QUERY_LENGTH = 1000` constant (ISSUE-18) | Small |
| P1-05 | `src/services/reactionService.js:53–65` | Remove dead `getReactionCountsForReview` function (ISSUE-08) | Small |
| P1-06 | `src/scripts/tasks/attractions.js:3` | Replace `require("firebase-admin")` with `require("../../config/firebase")` (ISSUE-07) | Small |
| P1-07 | `src/scripts/tasks/attractions.js:17,19` | Fix misleading "Foursquare" label to "Overpass (OpenStreetMap)" (ISSUE-09) | Small |
| P1-08 | `src/scripts/tasks/summaries.js:5` | Remove stale `MODEL` constant and use value from `aiSummaryService.js` (ISSUE-06) | Small |
| P1-09 | `src/scripts/devInit.js:322–329` | Remove inline `toNumOrNull`/`clamp0to100` and import from `src/lib/numbers.js` (ISSUE-02) | Small |
| P1-10 | `src/controllers/cityController.js:98` | Add empty-rows guard before `db.getAll()` in `recommendCities` (ISSUE-21) | Small |
| P1-11 | `src/controllers/aiController.js:199–201` | Add `console.error` log to the silently-swallowed catch in `loadSessionMessages` (ISSUE-19) | Small |
| P1-12 | `src/controllers/aiController.js:57–72` | Remove `which` from the ranking-word gating regex (ISSUE-24) | Small |
| P1-13 | `src/controllers/authController.js:62–63` | Return generic error message for missing `SESSION_JWT_SECRET` (ISSUE-32) | Small |
| P1-14 | `src/controllers/authController.js:33–37` | Remove redundant runtime `process.env.SESSION_JWT_SECRET` check (ISSUE-16) | Small |
| P1-15 | `src/controllers/aiController.js:418–419` | Add UUID format validation for `requestedSessionId` in `runAiQuery` (ISSUE-25) | Small |
| P1-16 | `src/lib/slugs.js:5–11` | Add `@deprecated` JSDoc to `censusNameToSlug` (ISSUE-38) | Small |
| P1-17 | `src/app.js:25–28` | Move `CLIENT_ORIGINS` into `src/config/env.js` with startup warning (ISSUE-33) | Small |
| P1-18 | `test/app.smoke.test.js:289` | Split ambiguous CSRF smoke test into two specific assertions (ISSUE-41) | Small |

### P2 — Fix in a branch (medium impact, some regression risk)

| # | File | Description | Effort |
|---|------|-------------|--------|
| P2-01 | `src/controllers/cityController.js:65–67` | Move `city_stats` Firestore read out of `getCitySummary` controller into `aiSummaryService` (ISSUE-13) | Small |
| P2-02 | `src/controllers/reactionController.js:30–51` | Move review existence/ownership checks from `upsertReaction` controller into `reactionService` (ISSUE-15) | Medium |
| P2-03 | `src/controllers/cityController.js:82–163` + `src/services/cityService.js` | Extract `recommendCities` algorithm into `cityService.recommendCities()` and eliminate the secondary `db.getAll()` call (ISSUES-14, 29) | Medium |
| P2-04 | `src/middleware/requireAuth.js` + `src/middleware/optionalAuth.js` | Extract shared dev-bypass logic into `src/middleware/authHelpers.js` (ISSUE-04) | Small |
| P2-05 | `src/scripts/devInit.js` + `src/scripts/seedMissingReviews.js` | Extract shared seed utilities into `src/scripts/lib/seedUtils.js` (ISSUE-01) | Medium |
| P2-06 | `src/scripts/tasks/safety.js` + `src/scripts/tasks/safetyApi.js` | Move shared calibration constants and `computeSafetyScore` into `src/scripts/lib/safetyCalibration.js` (ISSUE-03) | Small |
| P2-07 | `src/services/aiSummaryService.js:121–136` | Add try/catch around `generateCitySummary`; return stale cache on API failure (ISSUE-20) | Small |
| P2-08 | `src/controllers/aiController.js:443–445` | Reset `apiMessages` to `[...sessionMessages]` before calling `executeAgenticLoop` when `executePreRanking` fails (ISSUE-23) | Small |
| P2-09 | `src/scripts/tasks/safety.js:143–176` | Batch-read all `city_metrics` before the CSV loop instead of per-city serial reads (ISSUE-30) | Small |
| P2-10 | `src/scripts/tasks/summaries.js:27–35` | Batch-read all `city_summaries` before the loop (ISSUE-31) | Small |
| P2-11 | `test/` | Add `test/controllers.aiController.test.js` for `detectRankingMetric`, `detectStateFilter`, `sanitizeCityLine` (ISSUE-39) | Medium |
| P2-12 | `test/` | Add `test/services.reactionService.test.js` covering all exported functions (ISSUE-40) | Medium |
| P2-13 | `test/` | Add `test/services.aiQueryService.test.js` covering `rankCities`, `filterCities`, `getCity` (ISSUE-42) | Large |
| P2-14 | `src/services/meService.js:197` | Wrap post-set `ref.get()` in `updateProfile` or avoid the re-read (ISSUE-22) | Small |
| P2-15 | `src/services/fbiService.js:17` | Move `FBI_API_KEY` from query param to request header (ISSUE-34) | Small |
| P2-16 | `test/services.cityService.test.js` | Replace call-count hack in db mock with path-based dispatch (ISSUE-43) | Small |

### P3 — Defer (low ROI or high risk)

| # | File | Description | Effort |
|---|------|-------------|--------|
| P3-01 | `src/services/reviewService.js:32–140` | Extract `computeStatsDelta` from `upsertMyReviewForCity` for isolated testability (ISSUE-36) | Medium |
| P3-02 | `src/scripts/devInit.js:389–528` | Refactor `main()` into named step functions (ISSUE-37) | Medium |
| P3-03 | `src/services/foursquareService.js` | Rename file to `overpassService.js` and update all imports (continuation of ISSUE-09) | Large |
| P3-04 | `src/controllers/cityController.js:82–163` | Add phase-level comments to `recommendCities` as a minimum readability improvement (ISSUE-35) | Small |
| P3-05 | `test/` | Add `test/services.aiSummaryService.test.js` covering `shouldRegenerate` logic (ISSUE-42) | Small |
| P3-06 | `src/services/aiQueryService.js:24–31` | Add a unit test asserting `nameToSlugGuess("Portland, OR") === "portland-or"` to guard the slug-matching logic (ISSUE-12) | Small |
| P3-07 | `src/scripts/tasks/airQuality.js` + `src/scripts/tasks/attractions.js` | Extract `sleep` utility to `src/scripts/lib/sleep.js` (ISSUE-05) | Small |
