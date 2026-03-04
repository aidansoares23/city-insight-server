# city-insight-server

Backend API server for the City Insight application.

## Overview

- Runtime: Node.js
- Framework: Express 5
- Data store: Firestore (via `firebase-admin`)
- Auth: Google ID token verification + server-signed JWT session cookie
- Deployment target: Render
- Entry point: `src/index.js`

## Tech Stack

- `express` (v5)
- `firebase-admin` / `firebase`
- `google-auth-library`
- `jsonwebtoken`
- `helmet`
- `cors`
- `cookie-parser`
- `dotenv`
- `commander` (admin CLI tasks)

## Scripts

From `package.json`:

```bash
npm run dev
npm start
npm test
```

- `npm run dev` -> `nodemon src/index.js`
- `npm start` -> `node src/index.js`
- `npm test` -> `node --test`

## Project Structure

```text
src/
  index.js                  # server entrypoint
  app.js                    # express app, middleware, routes

  config/
    env.js                  # env parsing + safety checks
    firebase.js             # firebase-admin init + firestore export

  routes/
    authRoutes.js
    cityRoutes.js
    meRoutes.js

  controllers/
    cityController.js
    reviewController.js
    meController.js

  services/
    cityService.js
    reviewService.js
    meService.js
    metricsService.js       # currently empty

  middleware/
    requireAuth.js
    errorHandlers.js

  utils/
    cityMetrics.js
    cityStats.js
    timestamps.js

  lib/
    firestore.js
    reviews.js
    slugs.js
    meta.js
    numbers.js
    objects.js
    errors.js

  scripts/
    ci.js                   # admin task CLI
    devInit.js              # local seeding script
    lib/initAdmin.js
    tasks/
      metrics.js
      safety.js
      stats.js
      livability.js
      cleanupMetrics.js
      run.js

  data/
    *.csv                   # safety input data

test/
  app.smoke.test.js         # smoke tests
```

## Environment Variables

Defined by current code paths:

### Required for normal server operation

```bash
FIREBASE_SERVICE_ACCOUNT_PATH=./path/to/serviceAccountKey.json
SESSION_JWT_SECRET=replace-me
REVIEW_ID_SALT=replace-me
GOOGLE_CLIENT_ID=your-google-client-id
```

### Optional / behavior control

```bash
NODE_ENV=development
PORT=3000
CLIENT_ORIGINS=http://localhost:5173
DEV_AUTH_BYPASS=false
```

Notes:

- `.env` is loaded via `dotenv` in `src/index.js`.
- `FIREBASE_SERVICE_ACCOUNT_PATH` may be absolute or relative to repo root.
- `DEV_AUTH_BYPASS=true` is blocked in production by `src/config/env.js`.

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Create `.env` with the variables above.
3. Start dev server:

```bash
npm run dev
```

Default local URL:

```text
http://localhost:3000
```

Health check:

```text
GET /health
```

## Authentication Model

### Login flow

1. Client gets a Google ID token.
2. Client calls `POST /api/auth/login` with `{ "idToken": "..." }`.
3. Server verifies token with `google-auth-library`.
4. Server sets `ci_session` cookie signed with `SESSION_JWT_SECRET`.

Cookie behavior:

- `httpOnly: true`
- `path: /`
- `maxAge: 7 days`
- `secure: true` in production
- `sameSite: "none"` in production, `"lax"` otherwise

### Auth for protected routes

- Middleware: `src/middleware/requireAuth.js`
- Reads JWT from `ci_session` cookie
- Sets `req.user` from JWT claims

### Development auth bypass

If `DEV_AUTH_BYPASS=true` and request is local-only:

- authenticated identity comes from `x-dev-user` header
- bypass is refused for non-local requests

## CSRF-lite Requirement

State-changing requests require this header:

```text
x-requested-with: XMLHttpRequest
```

Applied in auth and protected route middleware for `POST`, `PUT`, `PATCH`, `DELETE`.

## API Reference

Base path: `/api`

### Health

- `GET /health`

### Auth

- `POST /api/auth/login`
  - Body: `{ "idToken": "..." }`
- `POST /api/auth/logout`

### Me

- `GET /api/me` (auth required)
- `GET /api/me/reviews` (auth required)
  - Query:
    - `limit` (max 100 in service code)

### Cities

- `GET /api/cities`
  - Query:
    - `limit` (1..100, default 50)
    - `q` (case-insensitive contains filter on name/state/slug)
    - `sort`:
      - `name_asc` (default)
      - `livability_desc`
      - `safety_desc`
      - `rent_asc`
      - `rent_desc`
      - `reviews_desc`
- `GET /api/cities/:slug`
- `GET /api/cities/:slug/details`

### City Reviews

- `GET /api/cities/:slug/reviews`
  - Query:
    - `pageSize` (1..50, default 10)
    - preferred cursor:
      - `cursorId`
      - `cursorCreatedAtIso`
    - back-compat cursor:
      - `after`
- `GET /api/cities/:slug/reviews/:reviewId`
- `GET /api/cities/:slug/reviews/me` (auth required)
- `POST /api/cities/:slug/reviews` (auth required)
- `DELETE /api/cities/:slug/reviews/me` (auth required)

Review payload validation (`POST /api/cities/:slug/reviews`):

- `ratings` is required with integer keys `1..10`:
  - `safety`
  - `cost`
  - `traffic`
  - `cleanliness`
  - `overall`
- `comment` is optional, `string | null`, max length `800`

## Firestore Collections (Current Code)

- `cities`
- `city_stats`
- `city_metrics`
- `reviews`
- `users`

## Admin / Data Tasks

Task CLI entrypoint:

```bash
node src/scripts/ci.js --help
```

Global CLI options:

- `--dry-run`
- `--verbose`

### Add or update a city (recommended for onboarding)

```bash
node src/scripts/ci.js city-upsert \
  --slug san-luis-obispo-ca \
  --name "San Luis Obispo" \
  --state CA \
  --lat 35.2828 \
  --lng -120.6596 \
  --tagline "College town with coastal access" \
  --description "Mid-size Central Coast city with strong outdoor access." \
  --highlights "Downtown,Trails,Food"
```

Dry run:

```bash
node src/scripts/ci.js --dry-run city-upsert --slug san-luis-obispo-ca --name "San Luis Obispo" --state CA
```

### Metrics sync (ACS population/rent)

```bash
node src/scripts/ci.js metrics
node src/scripts/ci.js metrics --cities san-francisco-ca,san-jose-ca
node src/scripts/ci.js --dry-run metrics
```

### Safety sync (CSV-driven)

```bash
node src/scripts/ci.js safety
node src/scripts/ci.js safety --dir src/data
node src/scripts/ci.js --dry-run safety
```

### Recompute stats from reviews

```bash
node src/scripts/ci.js stats --all
node src/scripts/ci.js stats --city san-francisco-ca
node src/scripts/ci.js --dry-run stats --all
```

### Recompute livability from stats + metrics

```bash
node src/scripts/ci.js livability --all
node src/scripts/ci.js livability --city san-francisco-ca
```

### Cleanup legacy city_metrics fields

```bash
node src/scripts/ci.js cleanup-metrics
node src/scripts/ci.js cleanup-metrics --cities los-angeles-ca,san-diego-ca
node src/scripts/ci.js --dry-run cleanup-metrics
```

### Run explicit pipeline

```bash
node src/scripts/ci.js run --steps metrics,safety,stats,livability --all
```

### Weekly refresh shortcut

```bash
node src/scripts/ci.js weekly-refresh
```

### Dev seed script

Seed/reset only. This script is intended for local bootstrap and can reset/wipe data.

```bash
node src/scripts/devInit.js
node src/scripts/devInit.js --skipMetrics
node src/scripts/devInit.js --wipeSeededReviews
node src/scripts/devInit.js --wipeAllReviews
```

## Testing

Run tests:

```bash
npm test
```

Current suite (`test/app.smoke.test.js`) covers smoke-level API behavior with service mocks.

## Production (Render)

- Start command: `npm start`
- Server binds `0.0.0.0` and `PORT` from environment.
- Configure environment variables in Render dashboard.
- In production, app sets `trust proxy` for secure cookie/proxy behavior.

## Security Notes

- `helmet` for standard security headers.
- CORS allowlist via `CLIENT_ORIGINS`.
- Cookie parsing via `cookie-parser`.
- JWT session verification via `jsonwebtoken`.
- Google ID token verification via `google-auth-library`.
- Firestore access uses `firebase-admin` with service account credentials.
- Centralized JSON error responses via `middleware/errorHandlers.js`.
