# CityInsight Backend Architecture

A comprehensive technical overview of the CityInsight REST API backend — a Node.js/Express server that serves city livability data, manages user reviews and reactions, and powers an AI-driven conversational assistant for city discovery.

---

## Tech Stack

| Component | Technology | Version |
|-----------|------------|---------|
| **Runtime** | Node.js | 22 |
| **Framework** | Express | 5.2.1 |
| **Database** | Firestore (Firebase Admin SDK) | 12.7.0 |
| **Authentication** | Google OAuth 2.0 + JWT | google-auth-library 10.5.0, jsonwebtoken 9.0.3 |
| **AI / Agentic** | Anthropic SDK (Claude Haiku 4.5) | @anthropic-ai/sdk 0.80.0 |
| **Rate Limiting** | express-rate-limit | 8.3.1 |
| **Security** | Helmet | 8.1.0 |
| **CORS** | cors | 2.8.5 |
| **Cookie Parsing** | cookie-parser | 1.4.7 |
| **Admin CLI** | Commander.js | 14.0.3 |
| **Environment** | dotenv | 17.2.3 |
| **Testing** | Node.js built-in test runner | (native) |

## Directory Structure

```
src/
├── index.js                      # Entry point; loads .env, binds PORT
├── app.js                        # Express app: middleware, CORS, routes
├── config/
│   ├── env.js                    # Environment variable validation
│   ├── firebase.js               # Firebase Admin SDK init
│   └── anthropic.js              # Anthropic SDK client init
├── routes/
│   ├── authRoutes.js             # POST /login, /logout
│   ├── cityRoutes.js             # City endpoints
│   ├── meRoutes.js               # User profile endpoints
│   └── aiRoutes.js               # AI query endpoints
├── controllers/
│   ├── authController.js         # OAuth verification, JWT issuance
│   ├── cityController.js         # City listing, details, summaries
│   ├── reviewController.js       # Review CRUD
│   ├── reactionController.js     # Review reactions
│   ├── meController.js           # User operations
│   └── aiController.js           # Agentic loop, intent detection
├── services/
│   ├── aiQueryService.js         # AI tool implementations
│   ├── aiSummaryService.js       # AI city snapshot generation
│   ├── airQualityService.js      # OpenAQ API client
│   ├── censusService.js          # Census ACS API client
│   ├── cityService.js            # City list, details, caching
│   ├── fbiService.js             # FBI Crime API client
│   ├── foursquareService.js      # Overpass API client
│   ├── meService.js              # User CRUD
│   ├── reactionService.js        # Reactions
│   └── reviewService.js          # Review transactions
├── middleware/
│   ├── requireAuth.js            # Auth enforcement
│   ├── optionalAuth.js           # Optional auth
│   ├── rateLimiter.js            # Rate limiting
│   └── errorHandlers.js          # Error responses
├── lib/
│   ├── aiTools.js                # Tool definitions (5 tools)
│   ├── errors.js                 # AppError class
│   ├── firestore.js              # Timestamp/cursor helpers
│   ├── reviews.js                # Validation, ID generation
│   ├── numbers.js                # Number utilities
│   ├── slugs.js                  # Slug helpers
│   ├── objects.js                # Object utilities
│   └── meta.js                   # Pipeline metadata
├── utils/
│   ├── cityStats.js              # Livability computation
│   ├── cityMetrics.js            # Metrics aggregation
│   └── timestamps.js             # Timestamp helpers
├── scripts/                      # Admin CLI (Commander.js)
│   ├── ci.js                     # CLI entrypoint
│   ├── devInit.js                # Dev initialization
│   └── tasks/                    # Pipeline tasks
└── data/
    ├── cities-ca-batch.json      # Seed data
    └── *.csv                     # Historical data

test/                             # 152 tests across 12 suites
```

## API Endpoints

### Authentication — `/api/auth`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Verify Google ID token, sign JWT, set httpOnly cookie |
| POST | `/api/auth/logout` | Clear session cookie |

### Cities — `/api/cities`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cities` | List cities with optional search, sort, and limit |
| POST | `/api/cities/recommend` | Recommend cities by weighted preferences |
| GET | `/api/cities/:slug` | Single city by slug |
| GET | `/api/cities/:slug/details` | Full city details including stats and metrics |
| GET | `/api/cities/:slug/attractions` | Points of interest by category |
| GET | `/api/cities/:slug/summary` | AI-generated city snapshot (cached) |

### Reviews — `/api/cities/:slug/reviews`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cities/:slug/reviews` | Paginated reviews with cursor-based pagination |
| GET | `/api/cities/:slug/reviews/me` | Authenticated user's review for the city |
| POST | `/api/cities/:slug/reviews` | Create or update review (atomic livability recompute) |
| DELETE | `/api/cities/:slug/reviews/me` | Delete user's review (atomic stats update) |
| GET | `/api/cities/:slug/reviews/:reviewId` | Single review by ID |

### Reactions — `/api/cities/:slug/reviews/:reviewId/reactions`

| Method | Path | Description |
|--------|------|-------------|
| PUT | `/api/cities/:slug/reviews/:reviewId/reactions/:type` | Add or toggle reaction (helpful/agree/disagree) |
| DELETE | `/api/cities/:slug/reviews/:reviewId/reactions` | Remove user's reaction |

### User Profile — `/api/me`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/me` | Get user profile (upserts on first login) |
| PATCH | `/api/me` | Update displayName |
| DELETE | `/api/me` | Delete account and cascade-delete all reviews |
| GET | `/api/me/reviews` | List all of user's reviews |
| GET | `/api/me/favorites` | List favorited cities |
| PUT | `/api/me/favorites/:slug` | Add city to favorites |
| DELETE | `/api/me/favorites/:slug` | Remove city from favorites |

### AI — `/api/ai`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ai/status` | Check if AI feature is enabled |
| POST | `/api/ai/query` | Execute agentic query (supports multi-turn via sessionId) |
| GET | `/api/ai/session/:sessionId` | Retrieve session message history |

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (used by frontend cold-start polling) |

## Controllers

### `authController.js`
- `login()` — Verifies Google ID token via `OAuth2Client.verifyIdToken()`, signs 7-day JWT, sets httpOnly `ci_session` cookie
- `logout()` — Clears session cookie

### `cityController.js`
- `listCities()` — City list with search (name/state), sort, and limit
- `getCityBySlug()` — Single city document
- `getCityDetails()` — Full city details including stats, metrics, and recent reviews
- `getCityAttractions()` — POI data organized by category (restaurants, outdoors, nightlife)
- `getCitySummary()` — AI-generated snapshot; checks cache before calling Anthropic
- `recommendCities()` — Multi-signal weighted scoring to surface best matches

### `reviewController.js`
- `createOrUpdateReviewForCity()` — Atomic upsert; recomputes city livability score in same transaction
- `listReviewsForCity()` — Cursor-based paginated list with batched reaction counts
- `getMyReviewForCity()` — Authenticated user's own review
- `deleteMyReviewForCity()` — Atomic deletion with stats rollback
- `getReviewByIdForCity()` — Single review lookup

### `reactionController.js`
- `upsertReaction()` — Create or update reaction (one per user per review)
- `deleteReaction()` — Remove user's reaction

### `meController.js`
- `getMe()` — User profile with automatic upsert on first visit
- `updateProfile()` — Update displayName field
- `listMyReviews()` — All reviews by the authenticated user
- `deleteAccount()` — Cascades: deletes user doc, all reviews, recalculates affected city stats
- `listMyFavorites()` — Favorite cities subcollection
- `addFavorite()` / `removeFavorite()` — Manage favorites subcollection

### `aiController.js`
- `getAiStatus()` — Returns `{ enabled: boolean }` based on `AI_ENABLED` env var
- `runAiQuery()` — Main entry point: intent detection → fast path or agentic loop → session persistence
- `getAiSession()` — Load session history from Firestore with access control

## Middleware

### `requireAuth.js`
- Reads `ci_session` httpOnly cookie, verifies JWT signature
- CSRF-lite check: requires `X-Requested-With: XMLHttpRequest` on state-changing methods (POST/PUT/PATCH/DELETE)
- Sets `req.user = { sub, email, name, picture, emailVerified }`
- Dev-only bypass available via `DEV_AUTH_BYPASS` env var (localhost only)

### `optionalAuth.js`
- Identical logic to `requireAuth` but never rejects
- Sets `req.user` if valid cookie present, otherwise `req.user = null`
- Used on endpoints that behave differently for authenticated vs anonymous users

### `rateLimiter.js`
Three separate limiters keyed by IP:
- **API**: 300 requests / 15 minutes
- **Auth**: 20 requests / 15 minutes
- **AI**: 20 requests / 15 minutes (tight due to Anthropic API costs)

### `errorHandlers.js`
- `notFoundHandler()` — Catches unmatched routes, returns 404 JSON
- `errorHandler()` — Central error formatter; maps `AppError` codes to HTTP status; hides internals in production

## Data Modeling

All data stored in **Firestore** (Google Cloud Firestore). No SQL schema — document-based with subcollections.

| Collection | Doc ID | Key Fields | Purpose |
|-----------|--------|-----------|---------|
| `cities` | slug | name, state, lat, lng, tagline, description, highlights | Base city metadata |
| `city_stats` | slug | count, sums, livability | Aggregate review counts and computed livability score |
| `city_metrics` | slug | medianRent, population, safetyScore, aqiValue | Objective external metrics |
| `city_metrics/{slug}/snapshots` | auto | pipelineId, syncedAt, prevValues, newValues | Metrics pipeline audit trail |
| `city_attractions` | slug | attractions, restaurants, outdoors, nightlife | POI data by category |
| `city_summaries` | slug | text, reviewCount, createdAt | Cached AI-generated city snapshots |
| `livability_config` | `norms` | norms | Distribution stats for livability normalization |
| `reviews` | HMAC(salt, userId:cityId) | userId, cityId, ratings, comment, isEdited | User reviews with deterministic ID |
| `review_reactions` | `{userId}:{reviewId}` | userId, reviewId, type, timestamps | One reaction per user per review |
| `users` | Google sub | email, name, picture, emailVerified, displayName | User profiles |
| `users/{sub}/favorites` | slug | (implicit) | Favorited cities subcollection |
| `ai_sessions` | UUID | userId, messages, lastActiveAt, turnCount | Multi-turn conversation history (max 40 msgs) |
| `ai_logs` | auto | query, response, toolCallTrace, sessionId | Full AI request audit trail |

### Key Design Decisions
- **Review IDs**: Deterministic HMAC(salt, `userId:cityId`) ensures one review per user per city at the database level
- **Livability recompute**: Every review write/delete recalculates `city_stats.livability` atomically in the same Firestore transaction
- **Cursor pagination**: Reviews paginated by `(createdAt, reviewId)` tuple to avoid offset performance problems

## Authentication

### Google OAuth 2.0 + JWT Flow

1. Client receives Google ID token via `@react-oauth/google`
2. Client POSTs token to `POST /api/auth/login`
3. Server calls `OAuth2Client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID })`
4. Server extracts payload: `{ sub, email, name, picture, email_verified }`
5. Server signs JWT: `sign({ sub, email, name, picture, emailVerified }, SESSION_JWT_SECRET, { expiresIn: "7d" })`
6. Server sets httpOnly cookie `ci_session`
7. All subsequent requests carry cookie automatically (browser handles this)
8. `requireAuth` middleware verifies JWT on protected routes

### Session Cookie Properties
```
Name:     ci_session
httpOnly: true        (inaccessible to JavaScript — XSS safe)
secure:   true        (HTTPS only in production)
sameSite: "none"      (production, cross-origin for Vercel→Render)
          "lax"       (development)
maxAge:   7 days
```

### CSRF Protection
State-changing requests (POST/PUT/PATCH/DELETE) must include:
```
X-Requested-With: XMLHttpRequest
```
This prevents cross-origin form submissions from triggering mutations.

## AI / Agentic Layer

This is the architectural centerpiece of CityInsight — an Anthropic-powered agentic loop that answers natural-language queries about city livability by autonomously calling backend data tools.

### Endpoint
`POST /api/ai/query`
```json
{
  "query": "What are the safest cities in California?",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### System Prompt
Built dynamically per request in `aiController.js`:
- Hard rules for the model (always use tools, never guess, always call `rankCities` for ranking questions, etc.)
- Alphabetically sorted list of all cities (for consistent prompt cache hits)
- Marked with `cache_control: { type: "ephemeral" }` for Anthropic prompt caching (~90% cost reduction on system prompt tokens for repeat queries)

### Tools (defined in `src/lib/aiTools.js`)

#### `getCity`
- **Purpose**: Look up a specific city by name
- **Returns**: Full city profile — tagline, description, highlights, livability stats, objective metrics
- **Behavior**: Returns up to 3 candidates if name is ambiguous

#### `aggregateReviews`
- **Purpose**: Get community sentiment for a city
- **Returns**: Rating averages, review count, livability score, up to 8 recent review excerpts
- **Use case**: Questions about what residents think or say

#### `compareCities`
- **Purpose**: Side-by-side data for 2–4 cities
- **Returns**: Full data array for each city
- **Use case**: "Compare Portland vs Seattle vs Denver"

#### `rankCities` (most critical)
- **Purpose**: Rank cities by a specific metric
- **Metrics**: `livabilityScore`, `safetyScore`, `affordability`, `reviewCount`, `walkabilityAvg`, `cleanlinessAvg`, `overallAvg`
- **Filters**: Optional 2-letter state abbreviation
- **Limit**: 1–10 results (default 5)
- **Rule**: Model is instructed to always use this tool for ranking questions — never rank by guessing

#### `filterCities`
- **Purpose**: Multi-criteria city filtering
- **Filters**: `minSafetyScore`, `maxMedianRent`, `minLivabilityScore`, `minWalkabilityAvg`, `minCleanlinessAvg`, `maxAqiValue`, `state`, `limit`
- **Returns**: Cities sorted by livability descending

### Execution Flow

**Step 1 — Intent Detection** (before calling Anthropic)

Two regex-based detectors run on the raw query:
- `detectRankingMetric(query)` → maps keywords to metric names
  - "safest" → `"safetyScore"`, "most affordable" → `"affordability"`, etc.
- `detectStateFilter(query)` → extracts state abbreviation
  - "in California" → `"CA"`

**Step 2 — Execution Path Selection**

If ranking intent detected:
- **Fast path**: Call `rankCities()` directly (no model turn needed)
- Inject synthetic `tool_use` + `tool_result` message pair into conversation
- Ask Claude to format the result only (`tool_choice: none`)
- Return formatted response

Otherwise:
- Enter **agentic loop** (general path)

**Step 3 — Agentic Loop** (up to 8 turns)

```
for turn in range(8):
    response = anthropic.messages.create(messages, tools, system)
    
    if response.stop_reason == "end_turn":
        return extract_text(response)
    
    if response.stop_reason == "tool_use":
        tool_calls = extract_tool_calls(response)
        results = execute_tools_parallel(tool_calls)
        messages.append(assistant_turn)
        messages.append(tool_results_turn)
        continue
    
    return whatever_text_exists(response)
```

**Step 4 — Tool Execution with Deduplication**

```javascript
// Within a single request, cache tool results by (toolName, input)
const cacheKey = `${toolName}:${JSON.stringify(input)}`;
if (toolResultCache.has(cacheKey)) return toolResultCache.get(cacheKey);
const result = await executeServiceFunction(toolName, input);
toolResultCache.set(cacheKey, result);
return result;
```

Prevents the model from making redundant calls to the same tool with the same input within one request.

**Step 5 — Session Persistence** (fire-and-forget after response sent)

```
ai_sessions/{sessionId}:
  userId, messages (up to 40), lastActiveAt, turnCount

ai_logs/{auto}:
  query, response, toolCallTrace, sessionId, createdAt
```

Multi-turn sessions: loading prior `sessionMessages` from Firestore and prepending to `apiMessages` before the agentic loop enables coherent multi-turn conversation. Sessions cap at 40 messages (20 turns); oldest messages trimmed FIFO.

### Model Configuration
- **Model**: `claude-haiku-4-5-20251001` (Claude Haiku 4.5 — fast and cost-efficient)
- **max_tokens**: 1024
- **Max agentic turns**: 8

## Testing

**Framework**: Node.js built-in test runner (`node --test`)

**Total**: 152 tests across 12 suites

**Run**:
```bash
npm test
```

### Test Suites

| Suite | What's Covered |
|-------|---------------|
| `app.smoke.test.js` | Integration: health endpoint, auth routes, unmatched routes |
| `lib.reviews.test.js` | Review validation, deterministic ID generation (HMAC) |
| `lib.numbers.test.js` | Number utility functions |
| `middleware.requireAuth.test.js` | Auth enforcement, JWT validation, CSRF check |
| `services.cityService.test.js` | City listing, search, sort, cache behavior |
| `services.reviewService.test.js` | Review upsert transaction, livability recompute, stats rollback |
| `services.meService.test.js` | User ops, cascade account deletion |
| `utils.cityStats.test.js` | Livability formula (v0 and v1), norms-based normalization |
| `utils.cityMetrics.test.js` | Metrics aggregation and scoring |

**CI/CD**: `.github/workflows/ci.yml` runs `npm test` on every push and pull request to `main`.

## Environment Configuration

### Required Variables

| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | `development` / `production` / `test` |
| `PORT` | HTTP port (default 3000) |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID |
| `SESSION_JWT_SECRET` | JWT signing secret |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Path to Firebase service account JSON |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `REVIEW_ID_SALT` | HMAC salt for deterministic review IDs |

### Optional Variables

| Variable | Purpose |
|----------|---------|
| `AI_ENABLED` | Feature flag for AI endpoints (default `true`) |
| `CLIENT_ORIGINS` | CORS allowlist (default `http://localhost:5173`) |
| `FIRESTORE_EMULATOR_HOST` | Local emulator (`localhost:8080`) |
| `DEV_AUTH_BYPASS` | Dev auth bypass (localhost only, non-production) |
| `FBI_API_KEY` | FBI Crime Data API |
| `OPENAQ_API_KEY` | OpenAQ air quality API |
| `FOURSQUARE_API_KEY` | Overpass/POI API |

## Deployment

**Platform**: Render (Node.js web service)

### Start Command
```bash
npm start   # → node src/index.js
```

### Startup Sequence
1. Load `.env` via dotenv
2. Validate required env vars (`config/env.js`)
3. Initialize Firebase Admin SDK (`config/firebase.js`)
4. Initialize Anthropic SDK client (`config/anthropic.js`)
5. Start Express on `0.0.0.0:PORT`
6. Log startup message with CORS allowlist

### Render Configuration
- **Build command**: `npm ci && npm test`
- **Start command**: `npm start`
- **Health check**: `GET /health`
- **Environment variables**: Managed via Render dashboard

### Key Architectural Properties
1. **Transactional consistency** — Review writes atomically recompute livability in Firestore transactions
2. **Prompt caching** — System prompt marked `ephemeral`; Anthropic caches it, reducing repeat-query costs ~90%
3. **Intent detection** — Pre-classifies ranking queries, bypasses agentic loop for speed and determinism
4. **Multi-turn sessions** — Conversation history persisted to Firestore, resumable via `sessionId`
5. **Tool deduplication** — In-request cache prevents redundant Anthropic tool calls
6. **Rate limiting** — Per-IP limits protect Anthropic API quota
7. **Observable AI** — Full audit log with tool call trace in `ai_logs` collection
8. **152 automated tests** — Covers services, middleware, utilities, and integration paths
