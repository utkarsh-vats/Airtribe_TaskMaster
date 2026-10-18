# TaskMaster

A collaborative task-tracking REST API. Users create projects, invite teammates, and work on tasks together through assignments, comments and attachments.

**Stack:** Node.js 22, TypeScript, Express 5, PostgreSQL 18, Prisma 6, Zod, Vitest

> 🚧 Work in progress. The full design is in [docs/DESIGN.md](docs/DESIGN.md).

## Prerequisites

- Node.js 20 or newer (22 recommended)
- Docker (for PostgreSQL)

## Setup

```bash
cp .env.example .env          # set POSTGRES_PASSWORD and JWT_ACCESS_SECRET
docker compose up -d          # Postgres 18.3 on localhost:5434, with `taskmaster` and `taskmaster_test` databases
npm install                   # also runs `prisma generate`
npm run db:migrate            # apply migrations to the dev database
npm run db:seed               # optional demo data (alice@example.com / bob@example.com, Password123!)
npm run dev                   # http://localhost:3000/health
```

## Tests

Tests run against a real PostgreSQL database (`<POSTGRES_DB>_test`). `.env.test` is loaded before `.env`, so tests reuse your Postgres credentials but never touch the dev database.

```bash
npm run test:db               # apply migrations to the test database (after any new migration)
npm test
```

## API

Base path `/api/v1`. Implemented so far:

| Method | Path                      | Auth   | Body                        | Success                                                         |
| ------ | ------------------------- | ------ | --------------------------- | --------------------------------------------------------------- |
| GET    | `/health` (no base path)  | —      | —                           | 200 `{ status, db }` (503 if the database is down)              |
| POST   | `/api/v1/auth/register`   | —      | `{ email, password, name }` | 201 user                                                        |
| POST   | `/api/v1/auth/login`      | —      | `{ email, password }`       | 200 `{ accessToken, refreshToken, expiresIn, tokenType, user }` |
| POST   | `/api/v1/auth/refresh`    | —      | `{ refreshToken }`          | 200 new `{ accessToken, refreshToken, expiresIn, tokenType }`   |
| POST   | `/api/v1/auth/logout`     | —      | `{ refreshToken }`          | 204                                                             |
| POST   | `/api/v1/auth/logout-all` | Bearer | —                           | 204                                                             |

Projects, members, tasks, comments and attachments follow; see [DESIGN.md §7](docs/DESIGN.md#7-api).

### Responses and errors

Success bodies are `{ "data": ... }`, plus `"meta": { page, limit, total, totalPages }` on paginated lists. Errors always look like this:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "email", "message": "Invalid email address" }],
    "requestId": "..."
  }
}
```

| HTTP | `code`                                                                           |
| ---- | -------------------------------------------------------------------------------- |
| 400  | `BAD_REQUEST` (malformed JSON)                                                   |
| 401  | `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `TOKEN_EXPIRED`, `INVALID_REFRESH_TOKEN`  |
| 404  | `NOT_FOUND`                                                                      |
| 409  | `CONFLICT` (e.g. email already registered)                                       |
| 422  | `VALIDATION_ERROR` (body, params or query failed validation; unknown fields too) |
| 429  | `RATE_LIMITED`                                                                   |
| 500  | `INTERNAL_ERROR` (no stack traces are ever sent)                                 |

Every response carries an `X-Request-Id` header (an incoming one is reused), matching `requestId` in errors and the logs.

## Authentication

- **Passwords** are hashed with argon2id. Emails are trimmed and lowercased before storage and lookup.
- **Access token:** JWT (HS256), 15 minutes by default (`ACCESS_TOKEN_TTL_SECONDS`). Send it as `Authorization: Bearer <token>`. An expired token returns 401 `TOKEN_EXPIRED`, which tells the client to refresh.
- **Refresh token:** 32 random bytes (base64url), 7 days by default (`REFRESH_TOKEN_TTL_DAYS`), sent in the JSON body. Only its SHA-256 hash is stored.
- **Rotation:** every refresh revokes the presented token and returns a new pair. Presenting a token that was already rotated or logged out is treated as theft: **all** of that user's sessions are revoked and the client must log in again. Clients should therefore not retry a refresh request with the same token.
- **Login** returns the same 401 `INVALID_CREDENTIALS` for an unknown email and a wrong password, and runs a dummy argon2 verify for unknown emails so response time doesn't reveal which emails exist.
- **Logout** revokes one refresh token (idempotent); **logout-all** revokes every session for the user.
- **Rate limit:** `/api/v1/auth/*` allows 10 requests per minute per IP (`RateLimit` headers are sent; 429 `RATE_LIMITED` when exceeded).

**Trade-offs**

- Logout can't revoke an access token that was already issued: it stays valid until it expires (at most 15 minutes). A `jti` denylist is the upgrade path.
- Refresh tokens travel in the JSON body because this is an API-only project. A browser app should receive them in an `httpOnly`, `Secure`, `SameSite` cookie instead so page scripts can't read them.

## Configuration

`DATABASE_URL` is assembled from the `POSTGRES_*` variables in `.env` (via dotenv-expand), so the credentials live in one place and Docker Compose reads the same values. Keep `POSTGRES_PASSWORD` URL-safe (letters, digits, `-`, `_`).

## Scripts

| Script                            | What it does                         |
| --------------------------------- | ------------------------------------ |
| `npm run dev`                     | Start with hot reload                |
| `npm run build` / `npm start`     | Compile to `dist/` and run it        |
| `npm run lint` / `npm run format` | ESLint / Prettier                    |
| `npm run format:check`            | Prettier check without writing       |
| `npm run typecheck`               | TypeScript without emitting          |
| `npm run db:migrate`              | Create and apply a migration (dev)   |
| `npm run db:studio`               | Browse the database in Prisma Studio |
| `npm test` / `npm run test:watch` | Run the test suite (once / watch)    |
| `npm run test:db`                 | Apply migrations to the test DB      |
