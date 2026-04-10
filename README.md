# City Insight — Server

REST API backend for City Insight, a platform where users discover cities, browse livability scores, and write reviews.

---

## Table of Contents

- [What it does](#what-it-does)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
  - [Project structure](#project-structure)
  - [Firestore collections](#firestore-collections)
  - [Request lifecycle](#request-lifecycle)
  - [Auth flow](#auth-flow)
  - [Adding a new metric pipeline](#adding-a-new-metric-pipeline)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Running the Server](#running-the-server)
- [Running Tests](#running-tests)
- [API Reference](#api-reference)
- [Admin CLI](#admin-cli)
- [Seeding Reviews](#seeding-reviews)
- [Scoring System](#scoring-system)

---

## What it does

- **City data** — serves California cities with livability scores, objective metrics (population, median rent, safety score, air quality), and search/sort/recommendation support
- **Reviews** — authenticated users create, update, and delete 1–10 ratings across safety, affordability, walkability, and cleanliness; livability scores recompute atomically on every write
- **Review reactions** — authenticated users can react to reviews with `helpful`, `agree`, or `disagree`; users cannot react to their own reviews
- **Favorites** — authenticated users can save cities to a personal favorites list
- **AI assistant** — agentic query endpoint powered by Claude Haiku; answers natural-language questions about cities using live Firestore data via tool use; supports multi-turn sessions via `sessionId`
- **City summaries** — AI-generated 3–4 sentence city snapshots, cached and regenerated after 50+ new reviews
- **Attractions** — per-city "things to do" data (restaurants, attractions, outdoors, nightlife) sourced from the OpenStreetMap Overpass API; synced via the `attractions` CLI task
- **Auth** — Google OAuth 2.0 login issues a signed JWT stored as an `httpOnly` session cookie; no tokens in localStorage
- **Data pipelines** — admin CLI syncs Census ACS metrics, fetches crime data from the FBI Crime Data Explorer API into safety scores, syncs air quality data from OpenAQ, and recomputes livability across all cities
- **Rate limiting and CSRF** — per-IP rate limits on all routes and auth endpoints; CSRF-lite via `X-Requested-With` header on state-changing requests

---

## Tech stack

| Layer         | Technology                            |
| ------------- | ------------------------------------- |
| Runtime       | Node.js 18+                           |
| Framework     | Express 5                             |
| Database      | Firestore (Firebase Admin SDK)        |
| Auth          | Google OAuth 2.0 + JWT session cookie |
| AI            | Anthropic SDK (Claude Haiku)          |
| Places data   | OpenStreetMap Overpass API            |
| Air quality   | OpenAQ API                            |
| Rate limiting | express-rate-limit                    |
| Admin CLI     | Commander.js                          |
| Testing       | Node.js built-in test runner          |
| Hosting       | Render                                |

---

## Architecture

### Project structure

```
src/
├── app.js                  # Express app: middleware, CORS, route mounting
├── index.js                # Entry point (binds port)
├── config/
│   ├── anthropic.js        # Anthropic SDK client init
│   ├── env.js              # Env var validation and export
│   └── firebase.js         # Firebase Admin SDK init (emulator-aware)
├── routes/                 # Thin route layer — wires URLs to controllers
│   ├── authRoutes.js
│   ├── cityRoutes.js
│   ├── meRoutes.js
│   └── aiRoutes.js
├── controllers/            # HTTP layer — parses requests, calls services
│   ├── aiController.js     # AI query handler; intent detection, tool loop, ai_logs write
│   ├── authController.js
│   ├── cityController.js
│   ├── meController.js
│   └── reactionController.js
├── services/               # Business logic + Firestore transactions
│   ├── aiQueryService.js   # AI tool implementations (getCity, rankCities, filterCities, …)
│   ├── aiSummaryService.js # City summary generation and caching
│   ├── airQualityService.js # OpenAQ API client (air quality / AQI data)
│   ├── censusService.js    # Census ACS API client (population, median rent)
│   ├── cityService.js      # City list (search/sort/paginate), details, attractions; in-memory caches
│   ├── fbiService.js       # FBI Crime Data Explorer API client (crime rates)
│   ├── foursquareService.js # OpenStreetMap Overpass API client → places by category
│   ├── meService.js        # User profile, review history, favorites, account deletion
│   ├── reactionService.js  # Review reactions (upsert, delete, count)
│   └── reviewService.js    # Upsert/delete with atomic stats recomputation
├── middleware/
│   ├── errorHandlers.js    # 404 handler + central error formatter
│   ├── optionalAuth.js     # JWT validation — sets req.user if valid, never 401
│   ├── rateLimiter.js      # Per-IP rate limiters (auth, AI, general)
│   └── requireAuth.js      # JWT validation, CSRF-lite, dev bypass
├── utils/
│   ├── cityMetrics.js      # Objective metrics with pipeline ownership model
│   └── cityStats.js        # Aggregation math, livability formulas (v0 fallback + v1 relative), norms computation
├── lib/                    # Pure utilities
│   ├── aiTools.js          # Anthropic tool definitions for the AI query endpoint
│   ├── errors.js           # AppError class
│   ├── firestore.js        # Timestamp helpers, cursor helpers
│   ├── meta.js             # Namespaced metadata builder for metrics pipelines
│   ├── numbers.js          # toNumOrNull, clamp, normalize, rangeScore, rangeScoreInverted
│   ├── objects.js          # isPlainObject
│   ├── reviews.js          # Validation rules, deterministic ID (HMAC-SHA-256)
│   └── slugs.js            # Slug normalization
└── scripts/
    ├── ci.js               # Admin CLI entrypoint (Commander.js)
    ├── devInit.js          # One-off dev environment initialization
    ├── seedMissingReviews.js # One-off: seeds fake reviews for cities with no reviews
    └── tasks/
        ├── airQuality.js   # OpenAQ API → city AQI sync
        ├── attractions.js  # Overpass API → city_attractions sync
        ├── cities.js       # city-upsert / city-upsert-batch tasks
        ├── livability.js   # Livability score recomputation (computes + stores norms on --all)
        ├── metrics.js      # ACS Census sync
        ├── run.js          # Pipeline orchestrator
        ├── safety.js       # Legacy: crime CSV → safety scores
        ├── safetyApi.js    # FBI Crime Data Explorer API → safety scores
        ├── stats.js        # Review aggregate recomputation
        └── summaries.js    # AI city summary generation

test/                       # Node built-in test runner, all services mocked
data/
└── cities-ca-batch.json    # California cities seed data
```

### Firestore collections

| Collection                      | Key                                      | Contents                                                                                                       |
| ------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `cities`                        | slug                                     | Name, state, lat/lng, tagline, description, highlights                                                         |
| `city_stats`                    | slug                                     | Review count, rating sums, livability score                                                                    |
| `city_metrics`                  | slug                                     | Population, median rent, safety score, AQI value                                                               |
| `city_metrics/{slug}/snapshots` | auto-id                                  | Immutable audit log written by each pipeline run: pipeline name, syncedAt, prevValues, newValues, changed flag |
| `city_attractions`              | slug                                     | Things-to-do data per city: attractions, restaurants, outdoors, nightlife; written by `attractions` task       |
| `city_summaries`                | slug                                     | Cached AI-generated city snapshots (3–4 sentences); regenerated after 50+ new reviews                         |
| `livability_config`             | `norms`                                  | Dataset-wide min/max distribution stats per signal (reviewOverall, safetyScore, medianRent, aqiValue); written by the livability pipeline, read by every review transaction |
| `reviews`                       | HMAC-SHA-256(key=salt, msg=userId:cityId) | Ratings, comment, timestamps                                                                                   |
| `review_reactions`              | `{userId}:{reviewId}`                    | Reaction type (helpful/agree/disagree), reviewer and review IDs, timestamps                                    |
| `users`                         | Google `sub`                             | Profile data from Google; subcollection `favorites` stores saved city slugs                                    |
| `ai_sessions`                   | UUID                                     | Multi-turn AI conversation history; max 40 messages (20 turns), trimmed FIFO                                   |
| `ai_logs`                       | auto-id                                  | AI query audit log: raw query, final response, tool call trace, timestamp                                      |

### Request lifecycle

A request travels through four layers:

```
routes/        Declares the URL pattern and attaches middleware (requireAuth, optionalAuth)
controllers/   Parses + validates the HTTP request, calls a service, shapes the response
services/      Business logic, Firestore reads/writes, transactions
lib/ + utils/  Pure functions — no I/O, fully unit-testable
```

**Adding a new endpoint:**

1. Add the route in the appropriate `routes/` file.
2. Write a controller function that validates input and calls a service.
3. Write (or extend) the service function for the business logic.
4. Add unit tests in `test/` — mock the Firestore calls with the existing pattern.

### Auth flow

```
Client                        Server                       Google
  │── POST /api/auth/login ──▶ │                              │
  │   { idToken }              │── verifyIdToken() ─────────▶ │
  │                            │◀── verified claims ───────── │
  │                            │  sign session JWT (7d)       │
  │◀── Set-Cookie: ci_session ─│                              │
  │    (httpOnly, secure)      │                              │
  │                            │                              │
  │── GET /api/me ────────────▶│                              │
  │   Cookie: ci_session       │  jwt.verify()                │
  │                            │  req.user = { sub, ... }     │
  │◀── { user: {...} } ────────│                              │
```

### Adding a new metric pipeline

`city_metrics` uses an ownership model to prevent pipelines from clobbering each other's fields. Each pipeline declares which fields it owns; writes outside that set are silently dropped.

**To add a new pipeline (e.g. `walkabilitySync` that writes `walkabilityScore`):**

1. Register it in `utils/cityMetrics.js`:

```js
const OWNERS = {
  metricsSync: new Set(["population", "medianRent"]),
  safetySync: new Set(["safetyScore", "crimeIndexPer100k"]),
  walkabilitySync: new Set(["walkabilityScore"]), // ← add this
};
```

2. Write a task in `src/scripts/tasks/` that calls `upsertCityMetrics(cityId, patch, { owner: "walkabilitySync" })`.

3. Wire the task into `src/scripts/tasks/run.js` and the CLI in `src/scripts/ci.js`.

4. If the new score should affect livability, update the formula in `utils/cityStats.js` and adjust the weights (they are renormalized automatically when signals are missing, so existing cities without the new data won't break). Run `livability --all` to recompute norms after adding the new signal.

Each pipeline run writes an immutable snapshot to `city_metrics/{slug}/snapshots` recording what changed, so you can audit or roll back individual pipeline updates.

---

## Getting Started

### Prerequisites

- Node.js 18+
- A Firebase project with Firestore enabled
- A Firebase service account JSON key
- A Google Cloud OAuth 2.0 client ID

### 1. Clone and install

```bash
git clone <repo-url>
cd city-insight-server
npm install
```

### 2. Get a Firebase service account key

In the Firebase Console: **Project Settings → Service Accounts → Generate new private key**

Save it somewhere safe (e.g. `~/.config/city-insight/serviceAccount.json`). **Do not commit it.**

### 3. Configure environment

Create a `.env` file in the project root:

```env
FIREBASE_SERVICE_ACCOUNT_PATH=/absolute/path/to/serviceAccount.json
SESSION_JWT_SECRET=<random-64-char-string>
REVIEW_ID_SALT=<random-64-char-string>
GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
ANTHROPIC_API_KEY=<your-anthropic-api-key>

# Optional
PORT=3000
NODE_ENV=development
CLIENT_ORIGINS=http://localhost:5173
DEV_AUTH_BYPASS=false
AI_ENABLED=true
```

> Generate secrets with: `openssl rand -hex 32`
> **Never change `REVIEW_ID_SALT` after launch** — it is used to derive all review document IDs. Changing it will orphan existing reviews.

---

## Environment Variables

| Variable                        | Required         | Description                                                                 |
| ------------------------------- | ---------------- | --------------------------------------------------------------------------- |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Yes              | Absolute path to your Firebase service account JSON key                     |
| `SESSION_JWT_SECRET`            | Yes              | Secret used to sign session JWTs. Generate with `openssl rand -hex 32`      |
| `REVIEW_ID_SALT`                | Yes              | Salt for deterministic review ID generation. **Never change after launch.** |
| `GOOGLE_CLIENT_ID`              | Yes              | OAuth 2.0 client ID from Google Cloud Console                               |
| `ANTHROPIC_API_KEY`             | Yes (AI)         | Anthropic API key. Required for the `/api/ai` endpoints                     |
| `FBI_API_KEY`                   | Yes (safety)     | FBI Crime Data Explorer API key. Required for the `safety-api` task         |
| `OPENAQ_API_KEY`                | Yes (air quality)| OpenAQ API key. Required for the `air-quality` task                         |
| `FOURSQUARE_API_KEY`            | No               | Foursquare API key (currently unused; Overpass API is used instead)         |
| `PORT`                          | No (def 3000)    | Port the server listens on                                                  |
| `NODE_ENV`                      | No (def dev)     | `development` or `production`                                               |
| `CLIENT_ORIGINS`                | No               | Comma-separated allowed CORS origins (def `http://localhost:5173`)          |
| `DEV_AUTH_BYPASS`               | No               | `true` to skip Google auth locally. Localhost-only; hard-blocked in prod    |
| `AI_ENABLED`                    | No (def true)    | `false` to disable the `/api/ai` endpoints without removing the API key     |
| `FIRESTORE_EMULATOR_HOST`       | No               | Firestore emulator address (e.g. `localhost:8080`) for local development    |

---

## Running the Server

```bash
# Development — auto-restarts on changes
npm run dev

# Production
npm start
```

The server starts at `http://localhost:3000` (or `$PORT`).

**Health check:**

```bash
curl http://localhost:3000/health
```

### Dev Auth Bypass

To skip Google sign-in locally, set `DEV_AUTH_BYPASS=true` in `.env`, then pass a fake user ID via header:

```bash
curl http://localhost:3000/api/me \
  -H "x-dev-user: test-user-123"
```

The bypass is localhost-only and hard-blocked in production.

---

## Running Tests

```bash
npm test
```

Uses Node.js's built-in test runner — no external framework needed. All Firestore calls are mocked, so no Firebase connection is required.

**152 tests** across 10 files:

| File                                  | Tests | What it covers                                                                          |
| ------------------------------------- | ----- | --------------------------------------------------------------------------------------- |
| `test/app.smoke.test.js`              | 11    | HTTP routes, auth, CSRF, account deletion                                               |
| `test/lib.numbers.test.js`            | 26    | Numeric utility functions including `rangeScore` / `rangeScoreInverted`                 |
| `test/lib.reviews.test.js`            | 20    | Review validation + deterministic ID generation                                         |
| `test/middleware.requireAuth.test.js` | 17    | JWT validation, dev bypass, CSRF-lite                                                   |
| `test/utils.cityStats.test.js`        | 37    | Aggregation math + livability v0/v1 formulas + norms computation                        |
| `test/tasks.safety.test.js`           | 15    | Safety score formula + CSV parsing                                                      |
| `test/services.meService.test.js`     | 10    | Account deletion (partial failure recovery), user profile, review list                  |
| `test/services.reviewService.test.js` | 7     | Cursor validation (both directions), review lookup                                      |
| `test/services.cityService.test.js`   | 9     | City list — all sort modes, search filter, 404 behaviour                                |
| `test/utils.cityMetrics.test.js`      | 5     | Metrics upsert, null-guard, snapshot audit, getCityMetrics                              |

CI runs `npm test` on every push and pull request to `main` via GitHub Actions.

---

## API Reference

### Common requirements

All state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) must include:

```
x-requested-with: XMLHttpRequest
```

Authenticated routes require a valid `ci_session` cookie (set automatically on login).

**Error response shape:**

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "City not found"
  }
}
```

Common codes: `NOT_FOUND`, `UNAUTHENTICATED`, `VALIDATION_ERROR`, `CSRF`, `CORS`, `RATE_LIMITED`, `BAD_CURSOR`, `INTERNAL`.

**Rate limits:**

| Scope                          | Limit                   | Response           |
| ------------------------------ | ----------------------- | ------------------ |
| General API                    | 300 req / 15 min per IP | `429 RATE_LIMITED` |
| Auth endpoints (`/api/auth/*`) | 20 req / 15 min per IP  | `429 RATE_LIMITED` |
| AI endpoints (`/api/ai/*`)     | 20 req / 15 min per IP  | `429 RATE_LIMITED` |

Rate-limited responses include a `Retry-After` header (seconds). The client should back off and retry after that interval.

**For contributors — how errors propagate:**

Services and controllers signal errors by throwing `AppError` from `lib/errors.js`. The central error handler in `middleware/errorHandlers.js` catches it and formats the response. Never call `res.status(...).json(...)` directly for domain errors — throw instead:

```js
const { AppError } = require("../lib/errors");

// In a service:
throw new AppError("City not found", { status: 404, code: "NOT_FOUND" });

// In a controller, unexpected errors are passed to Express's error pipeline:
} catch (err) {
  next(err);
}
```

---

### Auth — `/api/auth`

| Method | Path               | Auth | Description                                      |
| ------ | ------------------ | ---- | ------------------------------------------------ |
| `POST` | `/api/auth/login`  | —    | Exchange a Google `idToken` for a session cookie |
| `POST` | `/api/auth/logout` | —    | Clear the session cookie                         |

**Login:**

```json
// Request body
{ "idToken": "<Google ID token from client>" }

// Response
{ "ok": true, "user": { "sub": "...", "email": "...", "name": "...", "picture": "..." } }
```

The session cookie (`ci_session`) is `httpOnly`, 7-day expiry, `sameSite: none` in production for cross-site requests between the Vercel frontend and Render backend.

---

### Cities — `/api/cities`

| Method | Path                            | Auth | Description                                                      |
| ------ | ------------------------------- | ---- | ---------------------------------------------------------------- |
| `GET`  | `/api/cities`                   | —    | List cities with scores                                          |
| `POST` | `/api/cities/recommend`         | —    | Recommend top cities by weighted preference scores               |
| `GET`  | `/api/cities/:slug`             | —    | Basic city info                                                  |
| `GET`  | `/api/cities/:slug/details`     | —    | Full details: stats, metrics, recent reviews                     |
| `GET`  | `/api/cities/:slug/attractions` | —    | Things to do: restaurants, attractions, outdoors, nightlife      |
| `GET`  | `/api/cities/:slug/summary`     | —    | AI-generated city snapshot (cached; regenerates after 50 reviews)|

**List query params:**

| Param   | Default    | Description                                                                                |
| ------- | ---------- | ------------------------------------------------------------------------------------------ |
| `limit` | `50`       | Max results (1–100)                                                                        |
| `q`     | —          | Search by name, state, or slug                                                             |
| `sort`  | `name_asc` | `name_asc` · `livability_desc` · `safety_desc` · `rent_asc` · `rent_desc` · `reviews_desc` |

**`POST /api/cities/recommend` request body:**

```json
{
  "weights": {
    "safety": 8,
    "affordability": 6,
    "walkability": 7,
    "cleanliness": 5,
    "environment": 4
  },
  "state": "CA"
}
```

Weights are 0–10; they are normalized internally so only relative values matter. `state` is an optional 2-letter filter. Returns the top 5 matching cities with a `matchScore` (0–1) and `matchPct` (0–100).

**`GET /api/cities/:slug/attractions` response shape:**

```json
{
  "cityId": "portland-or",
  "syncedAtIso": "2024-11-01T12:00:00.000Z",
  "source": "OpenStreetMap Overpass API",
  "categories": {
    "attractions": [{ "name": "...", "category": "landmark", "lat": 45.5, "lng": -122.6 }],
    "restaurants": [...],
    "outdoors": [...],
    "nightlife": [...]
  }
}
```

Returns empty arrays if the `attractions` sync has not yet run for the city. Cache-Control: `public, max-age=300, stale-while-revalidate=600`.

**`GET /api/cities/:slug/summary` response shape:**

```json
{
  "summary": "Portland is a vibrant Pacific Northwest city known for...",
  "generatedAt": "2024-03-20T10:30:00.000Z",
  "fresh": false
}
```

Cache-Control: `public, max-age=300, stale-while-revalidate=600`.

---

### Reviews — `/api/cities/:slug/reviews`

| Method   | Path                                              | Auth     | Description                  |
| -------- | ------------------------------------------------- | -------- | ---------------------------- |
| `GET`    | `/api/cities/:slug/reviews`                       | Optional | Paginated review list        |
| `GET`    | `/api/cities/:slug/reviews/me`                    | Required | Current user's review        |
| `POST`   | `/api/cities/:slug/reviews`                       | Required | Create or update your review |
| `DELETE` | `/api/cities/:slug/reviews/me`                    | Required | Delete your review           |
| `GET`    | `/api/cities/:slug/reviews/:reviewId`             | —        | Single review by ID          |
| `PUT`    | `/api/cities/:slug/reviews/:reviewId/reactions/:type` | Required | Add or change a reaction |
| `DELETE` | `/api/cities/:slug/reviews/:reviewId/reactions`   | Required | Remove your reaction         |

**Review payload** (POST):

```json
{
  "ratings": {
    "overall": 8,
    "safety": 7,
    "affordability": 6,
    "walkability": 5,
    "cleanliness": 9
  },
  "comment": "Optional. Max 800 characters."
}
```

All five rating fields (`overall`, `safety`, `affordability`, `walkability`, `cleanliness`) are required integers from **1–10**.

When authenticated, the review list response includes a `myReaction` field on each review (`"helpful"`, `"agree"`, `"disagree"`, or `null`).

**Reactions:**

Valid `:type` values: `helpful`, `agree`, `disagree`. A user can only have one reaction per review — putting a new type replaces the old one. Users cannot react to their own reviews (403). Deleting a reaction is idempotent (200 even if no reaction exists).

**Pagination:**

Use `pageSize` (default 10, max 50). Each response includes a `nextCursor` object; pass its fields as query params on the next request to advance the page:

```bash
# First page
GET /api/cities/portland-or/reviews?pageSize=10

# Response includes:
# "nextCursor": { "id": "abc123", "createdAt": "2024-11-01T12:00:00.000Z" }

# Next page — pass both cursor fields
GET /api/cities/portland-or/reviews?pageSize=10&cursorId=abc123&cursorCreatedAt=2024-11-01T12:00:00.000Z
```

`nextCursor` is `null` when there are no more results. Both `cursorId` and `cursorCreatedAt` must be provided together — passing only one is a `400 BAD_CURSOR` error.

---

### Me — `/api/me`

| Method   | Path                      | Auth     | Description                                |
| -------- | ------------------------- | -------- | ------------------------------------------ |
| `GET`    | `/api/me`                 | Required | Current user profile                       |
| `DELETE` | `/api/me`                 | Required | Permanently delete account and all reviews |
| `GET`    | `/api/me/reviews`         | Required | All reviews by current user                |
| `GET`    | `/api/me/favorites`       | Required | List saved favorite cities                 |
| `PUT`    | `/api/me/favorites/:slug` | Required | Add a city to favorites (idempotent)       |
| `DELETE` | `/api/me/favorites/:slug` | Required | Remove a city from favorites (idempotent)  |

**`GET /api/me/reviews` query params:**

| Param   | Default | Description                   |
| ------- | ------- | ----------------------------- |
| `limit` | `50`    | Max results to return (1–100) |

**`DELETE /api/me`** has no body and returns `{ ok: true, deleted: true }` on success. All of the user's reviews are deleted in parallel and city stats are recomputed per review; the user document is always removed even if individual review deletions encounter transient errors. This action is irreversible.

**`GET /api/me/favorites`** response shape:

```json
{
  "favorites": [
    { "cityId": "portland-or", "createdAt": "2024-11-01T12:00:00.000Z" }
  ]
}
```

---

### AI — `/api/ai`

| Method | Path                       | Auth     | Description                               |
| ------ | -------------------------- | -------- | ----------------------------------------- |
| `GET`  | `/api/ai/status`           | —        | Returns `{ enabled: boolean }`            |
| `POST` | `/api/ai/query`            | Required | Run a natural-language city data query    |
| `GET`  | `/api/ai/session/:sessionId` | Required | Retrieve message history for a session  |

**`POST /api/ai/query` request body:**

```json
{
  "query": "Which cities have the best safety scores in California?",
  "sessionId": "optional-uuid-for-multi-turn-conversation"
}
```

`query` must be a non-empty string, max 1000 characters. Omit `sessionId` to start a new single-turn conversation; include it to continue an existing session (up to 20 turns / 40 messages).

**Response:**

```json
{
  "response": "**San Jose, CA** leads California with a safety score of **8.4/10**...",
  "toolCallTrace": [
    { "tool": "rankCities", "input": { "metric": "safetyScore", "limit": 10, "state": "CA" }, "result": { ... } }
  ],
  "sessionId": "uuid"
}
```

The endpoint runs an agentic tool-use loop using `claude-haiku-4-5-20251001`. Available tools:

| Tool               | Description                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `getCity`          | Look up a city's profile, stats, metrics, and highlights by name            |
| `aggregateReviews` | Get review statistics and up to 8 recent review excerpts for a city         |
| `compareCities`    | Fetch data for 2–4 cities side-by-side                                      |
| `rankCities`       | Top N cities by a metric; supports optional `state` filter                  |
| `filterCities`     | Multi-constraint filter: `minSafetyScore`, `maxMedianRent`, `minLivabilityScore`, `minWalkabilityAvg`, `minCleanlinessAvg`, `maxAqiValue`, `state`, `limit` |

Requires `ANTHROPIC_API_KEY` to be set. Returns `503 AI_DISABLED` if `AI_ENABLED=false`.

Rate limit: **20 req / 15 min per IP** (tighter than the general API because each query can trigger up to 8 Anthropic API calls internally).

All queries and responses are logged to the `ai_logs` Firestore collection.

**`GET /api/ai/session/:sessionId`** returns the full message history for a session. Users can only access their own sessions (or anonymous sessions); other users' sessions return 403.

---

## Admin CLI

Manages cities, data pipelines, and score recomputation. Never writes to production unless your `FIREBASE_SERVICE_ACCOUNT_PATH` points there.

```bash
node src/scripts/ci.js [--dry-run] [--verbose] <command>
```

`--dry-run` logs what would happen without writing anything to Firestore.

---

### `city-upsert` — Create or update a single city

```bash
node src/scripts/ci.js city-upsert \
  --slug "portland-or" \
  --name "Portland" \
  --state "OR" \
  --lat 45.5051 \
  --lng -122.6750 \
  --tagline "City of Roses" \
  --highlights "Walkability,Food Scene,Parks"
```

---

### `city-upsert-batch` — Seed cities from a JSON file

```bash
node src/scripts/ci.js city-upsert-batch --file src/data/cities-ca-batch.json
```

The file must be a JSON array of city objects with the same fields as `city-upsert`. `src/data/cities-ca-batch.json` contains the full set of California cities. Use `--dry-run` to preview writes without committing.

---

### `metrics` — Sync population + median rent from Census ACS API

```bash
# All cities
node src/scripts/ci.js metrics

# Specific cities
node src/scripts/ci.js metrics --cities "portland-or,seattle-wa"
```

---

### `safety-api` — Sync safety scores from FBI Crime Data Explorer API

```bash
# All cities
node src/scripts/ci.js safety-api

# Specific cities
node src/scripts/ci.js safety-api --cities "los-angeles-ca,san-francisco-ca"
```

Fetches crime rates from the [FBI Crime Data Explorer API](https://api.usa.gov/crime/fbi/cde) (`api.usa.gov`). Matches cities to FBI law enforcement agencies by name, pulls violent and property crime rates per 100k for the most recent years, and computes safety scores using the same weighted formula. No population data required — the FBI API returns rates already normalized per 100k residents. After updating scores, run `livability --all` to propagate the change.

Requires `FBI_API_KEY` in `.env`.

---

### `safety` — Parse crime CSVs into safety scores (legacy)

```bash
node src/scripts/ci.js safety
node src/scripts/ci.js safety --dir ./src/data
```

Legacy task. Expects one CSV per city named `<slug>.csv` in `src/data/` with violent and property crime counts by year. Superseded by `safety-api` for active use.

---

### `air-quality` — Sync AQI data from OpenAQ

```bash
# All cities
node src/scripts/ci.js air-quality

# Specific cities
node src/scripts/ci.js air-quality --cities "los-angeles-ca,fresno-ca"
```

Fetches air quality index values from the [OpenAQ API](https://openaq.org). Requires `OPENAQ_API_KEY` in `.env`. After updating AQI values, run `livability --all` to propagate the change.

---

### `stats` — Recompute review aggregates from source of truth

```bash
node src/scripts/ci.js stats --all
node src/scripts/ci.js stats --city "portland-or"
```

---

### `livability` — Recompute livability scores

```bash
node src/scripts/ci.js livability --all
node src/scripts/ci.js livability --city "portland-or"
```

`--all` also recomputes the dataset-wide min/max norms stored in `livability_config/norms`. Run this after any change to the dataset composition (new cities, new metric sources) or after updating safety scores or AQI values.

---

### `attractions` — Sync things-to-do from OpenStreetMap

Fetches places near each city from the [OpenStreetMap Overpass API](https://overpass-api.de) and writes them to `city_attractions`. Covers four buckets: attractions, restaurants, outdoors, and nightlife. Uses a 5-second delay between cities to respect the free public API.

```bash
# All cities
node src/scripts/ci.js attractions

# Specific cities
node src/scripts/ci.js attractions --cities "portland-or,seattle-wa"
```

No API key needed — the Overpass API is free and public.

---

### `run` — Orchestrate multiple steps

```bash
node src/scripts/ci.js run --steps "metrics,safety-api,stats,livability" --all
```

Supported step names: `metrics`, `safety-api`, `safety` (legacy), `air-quality`, `stats`, `livability`, `attractions`.

---

### `weekly-refresh` — Full pipeline

Runs: metrics → safety-api → air-quality → stats → livability for all cities.

```bash
node src/scripts/ci.js weekly-refresh
node src/scripts/ci.js --dry-run weekly-refresh
```

---

## Seeding Reviews

`src/scripts/seedMissingReviews.js` seeds fake reviews for any city that has no reviews yet (`city_stats.count === 0`). It writes 5 synthetic reviews per unreviewed city using deterministic seed users, then recomputes `city_stats` for all affected cities. Already-reviewed cities are left untouched.

```bash
# Preview which cities would be seeded (no writes)
node src/scripts/seedMissingReviews.js --dry-run

# Seed reviews
node src/scripts/seedMissingReviews.js
```

Requires `REVIEW_ID_SALT` and a valid `FIREBASE_SERVICE_ACCOUNT_PATH` in `.env`.

---

## Scoring System

### Safety Score (0–10)

Derived from the [FBI Crime Data Explorer API](https://api.usa.gov/crime/fbi/cde). For each city, the matching law enforcement agency is looked up by name; monthly violent and property crime rates per 100k residents are fetched for the most recent available years (typically 2020–2023), annualized, and averaged. A weighted average is then mapped to a 0–10 scale:

```
weightedAvg       = (violent × 3 + property × 1) / 4   ← annual per-100k rate, averaged over available years
safetyScore       = 10 − (weightedAvg / 2,500) × 10    ← clamped to [0, 10]
```

The FBI API returns rates already normalized per 100k residents, so no local population lookup is needed. A city at 2,500+ crimes per 100k scores 0; a city at 0 crimes scores 10.

### Livability Score (0–100)

A weighted blend of four signals scored **relative to all cities in the dataset** (v1 formula). Each signal is ranked within its observed min/max range — the best city on that metric scores 100, the worst scores 0. Missing signals are dropped and the remaining weights renormalized — a city with no safety data still gets a score from reviews, rent, and air quality:

| Signal             | Weight  | How it's derived                                                          |
| ------------------ | ------- | ------------------------------------------------------------------------- |
| Review overall     | **45%** | `(overallAvg − minAvg) / (maxAvg − minAvg) × 100`                        |
| Safety score       | **30%** | `(safety − minSafety) / (maxSafety − minSafety) × 100`                   |
| Rent affordability | **15%** | `(maxRent − medianRent) / (maxRent − minRent) × 100` (inverted)          |
| Air quality (AQI)  | **10%** | `(maxAqi − aqiValue) / (maxAqi − minAqi) × 100` (inverted — lower = better) |

The `min`/`max` values are computed from the live dataset on every `livability --all` run and stored in `livability_config/norms`. Review transactions read the stored norms so individual score updates remain O(1) without a full dataset scan.

A v0 fallback formula (50% review overall / 35% safety / 15% rent, absolute thresholds instead of relative norms) is used when `livability_config/norms` has not yet been computed. Run `livability --all` after first deploy to activate v1.

**Livability recalculates automatically** whenever a review is created, updated, or deleted — the stats update and livability recomputation happen atomically in the same Firestore transaction. Run `livability --all` after the first deploy, or any time the dataset composition changes significantly (new cities added, new metric sources synced), to refresh the norms.
