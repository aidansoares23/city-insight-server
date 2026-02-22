# City Insight Server

Node/Express API for **City Insight**.

Backed by **Firestore** (via Firebase Admin), with Google OAuth login
that mints an **HTTP-only session cookie**.

Provides endpoints for:

- Listing cities + card-friendly metrics\
- City details (stats + objective metrics + preview reviews)\
- Reviews (create/update/delete "my review", list reviews with cursor
  pagination)\
- `/me` user profile + my reviews

---

## Tech Stack

- Node.js + Express\
- Firestore (Firebase Admin SDK)\
- Auth: Google ID token → server session JWT stored in `ci_session`
  cookie\
- Security:
  - `helmet`
  - CORS allowlist
  - "CSRF-lite" header on state-changing requests

---

## Project Structure

    src/
      index.js               # Server entrypoint
      app.js                 # Express app + middleware + routes

      config/
        env.js               # Env parsing + safety checks
        firebase.js          # Firebase Admin init + db export

      routes/
        cityRoutes.js        # /api/cities/*
        meRoutes.js          # /api/me/*
        authRoutes.js        # /api/auth/*

      controllers/
        cityController.js
        reviewController.js
        meController.js

      middleware/
        requireAuth.js       # Cookie auth + CSRF-lite
        errorHandlers.js

      utils/
        cityStats.js         # Aggregation + livability helpers
        cityMetrics.js       # Safe upsert/read for objective metrics
        timestamps.js

---

## Setup

### 1) Install

```bash
npm install
```

### 2) Create `.env`

Create a `.env` file in the repo root.

### Required Variables

- `FIREBASE_SERVICE_ACCOUNT_PATH`\
  Absolute or relative path to your Firebase service account JSON
  (Admin SDK).

- `GOOGLE_CLIENT_ID`\
  Google OAuth Client ID used to verify ID tokens from the client.

- `SESSION_JWT_SECRET`\
  Secret used to sign the server session cookie JWT.

- `REVIEW_ID_SALT`\
  Salt for deterministic review document IDs (prevents guessing;
  enforces 1 review per user per city).

### Common / Recommended

- `CLIENT_ORIGINS`\
  Comma-separated allowlist for CORS.

- `DEV_AUTH_BYPASS`\
  `true` / `false` (dev only).

- `NODE_ENV`\
  `development` (default) or `production`

- `PORT`\
  Defaults to `3000`

### Example `.env`

    NODE_ENV=development
    PORT=3000

    CLIENT_ORIGINS=http://localhost:5173
    GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID

    SESSION_JWT_SECRET=dev-secret-change-me
    REVIEW_ID_SALT=dev-review-salt-change-me

    FIREBASE_SERVICE_ACCOUNT_PATH=./secrets/serviceAccountKey.json

    DEV_AUTH_BYPASS=true

---

## Running the Server

### Development

```bash
npm run dev
```

### Production

```bash
npm start
```

Server runs at:

    http://localhost:3000

Health check:

    GET /health

---

# Authentication

## How It Works

1.  Client obtains a Google ID token.
2.  Client calls `POST /api/auth/login` with `{ "idToken": "..." }`.
3.  Server verifies the token.
4.  Server sets a signed `ci_session` HTTP-only cookie.

Cookie settings:

- `httpOnly: true`
- `secure: true` (production)
- `sameSite: none` (production)

---

## CSRF-lite Requirement

State-changing requests must include:

    x-requested-with: XMLHttpRequest

Applies to POST, PUT, PATCH, DELETE, login, and logout routes.

---

# API Overview

Base URL: `/api`

## Auth

### Login

    POST /api/auth/login

Body:

```json
{ "idToken": "..." }
```

### Logout

    POST /api/auth/logout

---

## Me

### Get Current User

    GET /api/me

### Get My Reviews

    GET /api/me/reviews

---

## Cities

### List Cities

    GET /api/cities

Query parameters:

- `limit`
- `q`
- `sort`:
  - `name_asc`
  - `livability_desc`
  - `safety_desc`
  - `rent_asc`
  - `rent_desc`
  - `reviews_desc`

### Get City

    GET /api/cities/:slug

### Get City Details

    GET /api/cities/:slug/details

---

# Reviews

### List Reviews

    GET /api/cities/:slug/reviews

### Get Single Review

    GET /api/cities/:slug/reviews/:reviewId

### Get My Review

    GET /api/cities/:slug/reviews/me

### Create / Update Review

    POST /api/cities/:slug/reviews

Body:

```json
{
  "comment": "optional string (<= 800 chars)",
  "ratings": {
    "safety": 1-10,
    "cost": 1-10,
    "traffic": 1-10,
    "cleanliness": 1-10,
    "overall": 1-10
  }
}
```

### Delete Review

    DELETE /api/cities/:slug/reviews/me

---

# Firestore Collections

- `cities/{cityId}`\
- `city_metrics/{cityId}`\
- `city_stats/{cityId}`\
- `reviews/{reviewId}`\
- `users/{sub}`

---

# Deployment Notes

In production:

    NODE_ENV=production
    CLIENT_ORIGINS=<your deployed frontend origins>
    SESSION_JWT_SECRET=<strong secret>
    REVIEW_ID_SALT=<strong secret>

---

# License

ISC (per package.json).
