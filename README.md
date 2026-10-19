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

Set LOG_LEVEL=error to see server errors while running tests (e.g. `$env:LOG_LEVEL='error'; npm test` in PowerShell).

Tests are silent by default only while `LOG_LEVEL` is unset, so keep it out of `.env` (it defaults to `info` for the dev server anyway). Under `NODE_ENV=test`, passwords are hashed with the cheapest argon2id parameters the library allows to keep the suite fast; other environments use the library defaults.

## API

Base path `/api/v1`. Implemented so far:

| Method | Path                                                           | Auth                   | Body                                                                      | Success                                                               |
| ------ | -------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| GET    | `/health` (no base path)                                       | —                      | —                                                                         | 200 `{ status, db }` (503 if the database is down)                    |
| POST   | `/api/v1/auth/register`                                        | —                      | `{ email, password, name }`                                               | 201 user                                                              |
| POST   | `/api/v1/auth/login`                                           | —                      | `{ email, password }`                                                     | 200 `{ accessToken, refreshToken, expiresIn, tokenType, user }`       |
| POST   | `/api/v1/auth/refresh`                                         | —                      | `{ refreshToken }`                                                        | 200 new `{ accessToken, refreshToken, expiresIn, tokenType }`         |
| POST   | `/api/v1/auth/logout`                                          | —                      | `{ refreshToken }`                                                        | 204                                                                   |
| POST   | `/api/v1/auth/logout-all`                                      | Bearer                 | —                                                                         | 204                                                                   |
| GET    | `/api/v1/users/me`                                             | Bearer                 | —                                                                         | 200 user                                                              |
| PATCH  | `/api/v1/users/me`                                             | Bearer                 | `{ name?, bio?, avatarUrl? }` (at least one; `null` clears bio/avatarUrl) | 200 user                                                              |
| PATCH  | `/api/v1/users/me/password`                                    | Bearer                 | `{ currentPassword, newPassword }`                                        | 204; signs out every session                                          |
| GET    | `/api/v1/users/me/invitations`                                 | Bearer                 | —                                                                         | 200 my pending, unexpired invitations, with `project` and `invitedBy` |
| POST   | `/api/v1/projects`                                             | Bearer                 | `{ name, description? }`                                                  | 201 project; caller becomes OWNER                                     |
| GET    | `/api/v1/projects?page=&limit=`                                | Bearer                 | —                                                                         | 200 my projects, most recently updated first, paginated               |
| GET    | `/api/v1/projects/:projectId`                                  | member                 | —                                                                         | 200 project                                                           |
| PATCH  | `/api/v1/projects/:projectId`                                  | ADMIN+                 | `{ name?, description? }` (at least one)                                  | 200 project                                                           |
| DELETE | `/api/v1/projects/:projectId`                                  | OWNER                  | —                                                                         | 204; deletes its members, tasks, comments and attachments             |
| GET    | `/api/v1/projects/:projectId/members`                          | member                 | —                                                                         | 200 members: OWNER, ADMINs, MEMBERs, each by join date                |
| PATCH  | `/api/v1/projects/:projectId/members/:userId`                  | OWNER                  | `{ role }`; `OWNER` transfers ownership                                   | 200 updated member list                                               |
| DELETE | `/api/v1/projects/:projectId/members/:userId`                  | member (self) / ADMIN+ | —                                                                         | 204; leave or remove; their open tasks are unassigned                 |
| POST   | `/api/v1/projects/:projectId/invitations`                      | ADMIN+                 | `{ email, role? }` (`MEMBER` default; `ADMIN` needs OWNER)                | 201 invitation, expires in 7 days                                     |
| GET    | `/api/v1/projects/:projectId/invitations?status=&page=&limit=` | ADMIN+                 | —                                                                         | 200 invitations, newest first, paginated                              |
| DELETE | `/api/v1/projects/:projectId/invitations/:invitationId`        | ADMIN+                 | —                                                                         | 204; revokes a pending invitation                                     |
| POST   | `/api/v1/invitations/:invitationId/accept`                     | invitee                | —                                                                         | 200 `{ projectId, role }`; you become a member                        |
| POST   | `/api/v1/invitations/:invitationId/decline`                    | invitee                | —                                                                         | 204                                                                   |

A project in a response has `id, name, description, createdAt, updatedAt, myRole, memberCount`; single-project responses add `owner: { id, name, email }`. Pagination: `page` ≥ 1 (default 1), `limit` 1–100 (default 20).

Tasks, comments and attachments follow; see [DESIGN.md §7](docs/DESIGN.md#7-api).

### Permissions

Every project has exactly one OWNER; other members are ADMIN or MEMBER. Anyone who isn't a member gets **404** for the project and everything under it, so its existence isn't leaked. A member whose role is too low gets **403**. The full matrix is in [DESIGN.md §5](docs/DESIGN.md#5-roles-and-permissions).

- **Roles:** only the OWNER changes roles, and nobody can change their own (409). Setting someone's role to `OWNER` transfers ownership: the current owner becomes ADMIN in the same transaction.
- **Leaving and removal:** any member can leave except the OWNER, who must transfer ownership first (409). ADMINs can remove MEMBERs; the OWNER can remove ADMINs and MEMBERs. A removed or departing member's open tasks are unassigned; completed tasks, comments and attachments stay.
- **Invitations** go to an email address, so the invitee doesn't need an account yet: they see the invite under `/users/me/invitations` once registered with that email. ADMINs can invite MEMBERs; only the OWNER can invite ADMINs. One pending invitation per email per project (409 otherwise), and none for existing members (409).
- **Expiry** is checked when used: a pending invitation past its expiry date shows as `EXPIRED` in lists and filters, and accepting or declining it returns 410 `INVITATION_EXPIRED`. Accepting someone else's invitation returns 404, so its existence isn't revealed.

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

| HTTP | `code`                                                                                      |
| ---- | ------------------------------------------------------------------------------------------- |
| 400  | `BAD_REQUEST` (malformed JSON)                                                              |
| 400  | `INVALID_CURRENT_PASSWORD` (change password; not 401, so clients don't try a token refresh) |
| 401  | `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `TOKEN_EXPIRED`, `INVALID_REFRESH_TOKEN`             |
| 403  | `FORBIDDEN` (project member without the required role)                                      |
| 404  | `NOT_FOUND` (also for projects you're not a member of)                                      |
| 409  | `CONFLICT` (e.g. email already registered, already a member, invitation no longer pending)  |
| 410  | `INVITATION_EXPIRED` (accepting or declining an expired invitation)                         |
| 422  | `VALIDATION_ERROR` (body, params or query failed validation; unknown fields too)            |
| 429  | `RATE_LIMITED`                                                                              |
| 500  | `INTERNAL_ERROR` (no stack traces are ever sent)                                            |

Every response carries an `X-Request-Id` header (an incoming one is reused), matching `requestId` in errors and the logs.

## Authentication

- **Passwords** are hashed with argon2id. Emails are trimmed and lowercased before storage and lookup.
- **Access token:** JWT (HS256), 15 minutes by default (`ACCESS_TOKEN_TTL_SECONDS`). Send it as `Authorization: Bearer <token>`. An expired token returns 401 `TOKEN_EXPIRED`, which tells the client to refresh.
- **Refresh token:** 32 random bytes (base64url), 7 days by default (`REFRESH_TOKEN_TTL_DAYS`), sent in the JSON body. Only its SHA-256 hash is stored.
- **Rotation:** every refresh revokes the presented token and returns a new pair. Presenting a token that was already rotated or logged out is treated as theft: **all** of that user's sessions are revoked and the client must log in again. Clients should therefore not retry a refresh request with the same token.
- **Login** returns the same 401 `INVALID_CREDENTIALS` for an unknown email and a wrong password, and runs a dummy argon2 verify for unknown emails so response time doesn't reveal which emails exist.
- **Logout** revokes one refresh token (idempotent); **logout-all** revokes every session for the user.
- **Change password** checks the current password, then updates the hash and revokes every refresh token in one transaction.
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
