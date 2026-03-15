# City Insight — Server

REST API backend for City Insight, a platform where users discover cities, browse livability scores, and write reviews.

**Stack:** Node.js 18+, Express 5, Firestore, Google OAuth 2.0, JWT cookie sessions
**Deployed on:** Render

---

## Table of Contents

- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Running the Server](#running-the-server)
- [Running Tests](#running-tests)
- [API Reference](#api-reference)
- [Admin CLI](#admin-cli)
- [Scoring System](#scoring-system)
- [Architecture](#architecture)
  - [Request lifecycle](#request-lifecycle)
  - [Auth flow](#auth-flow)
  - [Adding a new metric pipeline](#adding-a-new-metric-pipeline)

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

# Optional
PORT=3000
NODE_ENV=development
CLIENT_ORIGINS=http://localhost:5173
DEV_AUTH_BYPASS=false
```

> Generate secrets with: `openssl rand -hex 32`
> **Never change `REVIEW_ID_SALT` after launch** — it is used to derive all review document IDs. Changing it will orphan existing reviews.

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

**138 tests, all passing** across 10 files:

| File                                  | Tests | What it covers                                                         |
| ------------------------------------- | ----- | ---------------------------------------------------------------------- |
| `test/app.smoke.test.js`              | 11    | HTTP routes, auth, CSRF, account deletion                              |
| `test/lib.numbers.test.js`            | 20    | Numeric utility functions                                              |
| `test/lib.reviews.test.js`            | 20    | Review validation + deterministic ID generation                        |
| `test/middleware.requireAuth.test.js` | 17    | JWT validation, dev bypass, CSRF-lite                                  |
| `test/utils.cityStats.test.js`        | 24    | Aggregation math + livability formula                                  |
| `test/tasks.safety.test.js`           | 15    | Safety score formula + CSV parsing                                     |
| `test/services.meService.test.js`     | 10    | Account deletion (partial failure recovery), user profile, review list |
| `test/services.reviewService.test.js` | 7     | Cursor validation (both directions), review lookup                     |
| `test/services.cityService.test.js`   | 9     | City list — all sort modes, search filter, 404 behaviour               |
| `test/utils.cityMetrics.test.js`      | 5     | Metrics upsert, null-guard, snapshot audit, getCityMetrics             |

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

| Method | Path               | Description                                      |
| ------ | ------------------ | ------------------------------------------------ |
| `POST` | `/api/auth/login`  | Exchange a Google `idToken` for a session cookie |
| `POST` | `/api/auth/logout` | Clear the session cookie                         |

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

| Method | Path                        | Auth | Description                                  |
| ------ | --------------------------- | ---- | -------------------------------------------- |
| `GET`  | `/api/cities`               | —    | List cities with scores                      |
| `GET`  | `/api/cities/:slug`         | —    | Basic city info                              |
| `GET`  | `/api/cities/:slug/details` | —    | Full details: stats, metrics, recent reviews |

**List query params:**

| Param   | Default    | Description                                                                                |
| ------- | ---------- | ------------------------------------------------------------------------------------------ |
| `limit` | `50`       | Max results (1–100)                                                                        |
| `q`     | —          | Search by name, state, or slug                                                             |
| `sort`  | `name_asc` | `name_asc` · `livability_desc` · `safety_desc` · `rent_asc` · `rent_desc` · `reviews_desc` |

---

### Reviews — `/api/cities/:slug/reviews`

| Method   | Path                                  | Auth     | Description                  |
| -------- | ------------------------------------- | -------- | ---------------------------- |
| `GET`    | `/api/cities/:slug/reviews`           | —        | Paginated review list        |
| `GET`    | `/api/cities/:slug/reviews/:reviewId` | —        | Single review                |
| `GET`    | `/api/cities/:slug/reviews/me`        | Required | Current user's review        |
| `POST`   | `/api/cities/:slug/reviews`           | Required | Create or update your review |
| `DELETE` | `/api/cities/:slug/reviews/me`        | Required | Delete your review           |

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

| Method   | Path              | Auth     | Description                                |
| -------- | ----------------- | -------- | ------------------------------------------ |
| `GET`    | `/api/me`         | Required | Current user profile                       |
| `GET`    | `/api/me/reviews` | Required | All reviews by current user                |
| `DELETE` | `/api/me`         | Required | Permanently delete account and all reviews |

**`GET /api/me/reviews` query params:**

| Param   | Default | Description                   |
| ------- | ------- | ----------------------------- |
| `limit` | `50`    | Max results to return (1–100) |

**`DELETE /api/me`** has no body and returns `{ ok: true, deleted: true }` on success. All of the user's reviews are deleted in parallel and city stats are recomputed per review; the user document is always removed even if individual review deletions encounter transient errors. This action is irreversible.

---

## Admin CLI

Manages cities, data pipelines, and score recomputation. Never writes to production unless your `FIREBASE_SERVICE_ACCOUNT_PATH` points there.

```bash
node src/scripts/ci.js [--dry-run] [--verbose] <command>
```

`--dry-run` logs what would happen without writing anything to Firestore.

---

### `city-upsert` — Create or update a city

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

### `metrics` — Sync population + median rent from Census ACS API

```bash
# All cities
node src/scripts/ci.js metrics

# Specific cities
node src/scripts/ci.js metrics --cities "portland-or,seattle-wa"
```

---

### `safety` — Parse crime CSVs into safety scores

```bash
node src/scripts/ci.js safety
node src/scripts/ci.js safety --dir ./src/data
```

Expects one CSV per city named `<slug>.csv` with violent and property crime counts by year. After updating scores, run `livability --all` to propagate the change.

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

---

### `run` — Orchestrate multiple steps

```bash
node src/scripts/ci.js run --steps "metrics,safety,stats,livability" --all
```

---

### `weekly-refresh` — Full pipeline

Runs: metrics → safety → stats → livability for all cities.

```bash
node src/scripts/ci.js weekly-refresh
node src/scripts/ci.js --dry-run weekly-refresh
```

---

## Scoring System

### Safety Score (0–10)

Derived from California OpenJustice crime data. A weighted average of violent (×3) and property (×1) crime is computed over the most recent 3 years, normalized to a per-100k rate, then mapped to a 0–10 scale:

```
weightedAvg       = (violent × 3 + property × 1) / 4   ← per year, averaged over 3 years
crimeIndexPer100k = (weightedAvg / population) × 100,000
safetyScore       = 10 − (crimeIndexPer100k / 2,500) × 10   ← clamped to [0, 10]
```

A city at 2,500+ crimes per 100k scores 0. A city at 0 crimes scores 10.

### Livability Score (0–100)

A weighted blend of up to three signals. Missing signals are dropped and the remaining weights are renormalized — a city with no safety data still gets a score from reviews and rent:

| Signal             | Weight  | How it's derived                                 |
| ------------------ | ------- | ------------------------------------------------ |
| Review overall     | **50%** | User average (1–10 → 0–100 linear)               |
| Safety score       | **35%** | From crime data pipeline (0–10 → 0–100)          |
| Rent affordability | **15%** | `(1 − medianRent / $3,500) × 100`, clamped 0–100 |

**Livability recalculates automatically** whenever a review is created, updated, or deleted — the stats update and livability recomputation happen atomically in the same Firestore transaction.

---

## Architecture

```
src/
├── app.js                  # Express app: middleware, CORS, route mounting
├── index.js                # Entry point (binds port)
├── config/
│   ├── env.js              # Env var validation and export
│   └── firebase.js         # Firebase Admin SDK init
├── routes/                 # Thin route layer — wires URLs to controllers
│   ├── authRoutes.js
│   ├── cityRoutes.js
│   └── meRoutes.js
├── controllers/            # HTTP layer — parses requests, calls services
│   ├── cityController.js
│   ├── reviewController.js
│   └── meController.js
├── services/               # Business logic + Firestore transactions
│   ├── cityService.js      # City list (search/sort/paginate), details
│   ├── reviewService.js    # Upsert/delete with atomic stats recomputation
│   └── meService.js        # User profile, review history
├── middleware/
│   ├── requireAuth.js      # JWT validation, CSRF-lite, dev bypass
│   └── errorHandlers.js    # 404 handler + central error formatter
├── utils/
│   ├── cityStats.js        # Aggregation math, livability formula (v0)
│   └── cityMetrics.js      # Objective metrics with pipeline ownership model
├── lib/                    # Pure utilities
│   ├── numbers.js          # toNumOrNull, toOptionalNumOrNull, clamp, normalize
│   ├── reviews.js          # Validation rules, deterministic ID (HMAC-SHA-256)
│   ├── errors.js           # AppError class
│   ├── firestore.js        # Timestamp helpers, cursor helpers
│   ├── meta.js             # Namespaced metadata builder for metrics pipelines
│   ├── objects.js          # isPlainObject
│   └── slugs.js            # Slug normalization
└── scripts/
    ├── ci.js               # Admin CLI entrypoint (Commander.js)
    └── tasks/
        ├── cities.js       # city-upsert task
        ├── metrics.js      # ACS Census sync
        ├── safety.js       # Crime CSV → safety scores
        ├── stats.js        # Review aggregate recomputation
        ├── livability.js   # Livability score recomputation
        └── run.js          # Pipeline orchestrator

test/                       # Node built-in test runner, all services mocked
```

### Firestore collections

| Collection                      | Key                         | Contents                                                                                                       |
| ------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `cities`                        | slug                        | Name, state, lat/lng, tagline, description, highlights                                                         |
| `city_stats`                    | slug                        | Review count, rating sums, livability score                                                                    |
| `city_metrics`                  | slug                        | Population, median rent, safety score, crime index                                                             |
| `city_metrics/{slug}/snapshots` | auto-id                     | Immutable audit log written by each pipeline run: pipeline name, syncedAt, prevValues, newValues, changed flag |
| `reviews`                       | HMAC-SHA-256(key=salt, msg=userId:cityId) | Ratings, comment, timestamps                                                                                   |
| `users`                         | Google `sub`                | Profile data from Google                                                                                       |

### Request lifecycle

A request travels through four layers:

```
routes/        Declares the URL pattern and attaches middleware (requireAuth)
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

4. If the new score should affect livability, update `computeLivabilityV0` in `utils/cityStats.js` and adjust the weights (they are renormalized automatically when signals are missing, so existing cities without the new data won't break).

Each pipeline run writes an immutable snapshot to `city_metrics/{slug}/snapshots` recording what changed, so you can audit or roll back individual pipeline updates.
