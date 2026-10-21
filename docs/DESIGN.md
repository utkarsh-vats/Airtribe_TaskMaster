# TaskMaster — Design Document

A collaborative task-tracking backend: users create projects, invite collaborators, and work on tasks together through assignments, comments, and attachments.

**Deadline:** 20 Oct 2026 **Stack:** Node.js 20+, TypeScript, Express 5.3.0, PostgreSQL 18.3, Prisma

---

## 1. Scope

| In scope (core)                                                      | Optional (built last, cut first) |
| -------------------------------------------------------------------- | -------------------------------- |
| Register, login, refresh, logout                                     | Real-time notifications over SSE |
| Profile view/update, change password                                 | AI-generated task descriptions   |
| Projects: create, list, view, update, delete                         |                                  |
| Membership with roles; invitations (invite, accept, decline, revoke) |                                  |
| Tasks: CRUD, assign, complete, filter, sort, search, paginate        |                                  |
| "My tasks" across all projects                                       |                                  |
| Comments and attachments at project level or task level              |                                  |
| Validation, consistent errors, tests, CI, README                     |                                  |

Out of scope: account deletion, email delivery (invitations are visible in-app), frontend.

---

## 2. Tech stack and key decisions

| Concern             | Choice                                                   | Why                                                                                                     |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Language            | TypeScript (strict)                                      | Type safety; reviewers expect it in 2026                                                                |
| Framework           | Express 5.3.0                                            | Rejected promises in async handlers go to the error middleware automatically, no `asyncHandler` wrapper |
| DB                  | PostgreSQL 18.3                                          | Relational data, partial indexes, `pg_trgm` for search                                                  |
| ORM                 | Prisma                                                   | Fastest path to typed queries and migrations in a 3-day window                                          |
| Validation          | Zod                                                      | Pydantic equivalent; schemas double as TS types                                                         |
| Password hashing    | argon2 (argon2id)                                        | Current OWASP recommendation                                                                            |
| Tokens              | `jsonwebtoken` access token + opaque refresh token in DB | Makes logout real (see §6)                                                                              |
| Uploads             | multer → `StorageDriver` interface (local disk impl)     | Swappable for S3 later                                                                                  |
| Real-time           | Server-Sent Events                                       | One-way server→client is all notifications need; simpler than WebSockets                                |
| Tests               | Vitest + supertest, real Postgres                        | Same approach as production; no DB mocks                                                                |
| Security middleware | helmet, cors, express-rate-limit                         | Standard hardening                                                                                      |
| Logging             | pino + pino-http                                         | Structured, request IDs                                                                                 |
| Dev                 | tsx (watch), ESLint, Prettier, Docker Compose            |                                                                                                         |

**Version notes**

- **Express 5:** `req.query` is a read-only getter, so `validate()` must not reassign it. Store parsed input on `req.validated` (`{ body, params, query }`) and read it from there in controllers. Wildcard routes need a name (`/*splat`, not `/*`), and `?` optional params are replaced by braces (`/:file{.:ext}`).
- **PostgreSQL 18 Docker image:** the data directory moved to `/var/lib/postgresql/18/docker`. Mount the volume at `/var/lib/postgresql` (not `/var/lib/postgresql/data`), or the container won't start with an old-style mount.

Architecture: **routes → controller → service → repository**.

- Controllers handle HTTP only (parse validated input, call a service, shape the response).
- Services hold business rules, permission checks, and transactions.
- Repositories wrap Prisma queries.

---

## 3. Entity-relationship diagram

```mermaid
erDiagram
    USERS ||--o{ REFRESH_TOKENS : "owns"
    USERS ||--o{ PROJECT_MEMBERS : "belongs via"
    PROJECTS ||--o{ PROJECT_MEMBERS : "has"
    USERS ||--o{ PROJECTS : "created"
    PROJECTS ||--o{ PROJECT_INVITATIONS : "issues"
    USERS ||--o{ PROJECT_INVITATIONS : "sent"
    PROJECTS ||--o{ TASKS : "contains"
    USERS ||--o{ TASKS : "created"
    USERS |o--o{ TASKS : "assigned to"
    PROJECTS ||--o{ COMMENTS : "contains"
    TASKS |o--o{ COMMENTS : "optionally on"
    USERS ||--o{ COMMENTS : "authored"
    PROJECTS ||--o{ ATTACHMENTS : "contains"
    TASKS |o--o{ ATTACHMENTS : "optionally on"
    USERS ||--o{ ATTACHMENTS : "uploaded"
    USERS ||--o{ NOTIFICATIONS : "receives"

    USERS {
        uuid id PK
        text email UK "stored lowercase"
        text password_hash
        text name
        text bio "nullable"
        text avatar_url "nullable"
        timestamptz created_at
        timestamptz updated_at
    }
    REFRESH_TOKENS {
        uuid id PK
        uuid user_id FK
        text token_hash UK "sha256 of opaque token"
        timestamptz expires_at
        timestamptz revoked_at "nullable"
        text user_agent "nullable"
        timestamptz created_at
    }
    PROJECTS {
        uuid id PK
        text name
        text description "nullable"
        uuid created_by FK
        timestamptz created_at
        timestamptz updated_at
    }
    PROJECT_MEMBERS {
        uuid project_id PK, FK
        uuid user_id PK, FK
        enum role "OWNER | ADMIN | MEMBER"
        timestamptz joined_at
    }
    PROJECT_INVITATIONS {
        uuid id PK
        uuid project_id FK
        text email "invitee, lowercase"
        enum role "ADMIN | MEMBER"
        enum status "PENDING | ACCEPTED | DECLINED | REVOKED | EXPIRED"
        uuid invited_by FK
        timestamptz expires_at
        timestamptz responded_at "nullable"
        timestamptz created_at
    }
    TASKS {
        uuid id PK
        uuid project_id FK
        varchar title "max 200"
        text description "nullable"
        enum status "OPEN | IN_PROGRESS | COMPLETED"
        enum priority "LOW | MEDIUM | HIGH | URGENT"
        timestamptz due_date "nullable"
        uuid created_by FK
        uuid assignee_id FK "nullable"
        timestamptz completed_at "nullable"
        timestamptz created_at
        timestamptz updated_at
    }
    COMMENTS {
        uuid id PK
        uuid project_id FK
        uuid task_id FK "nullable = project-level"
        uuid author_id FK
        text body
        timestamptz edited_at "nullable"
        timestamptz created_at
    }
    ATTACHMENTS {
        uuid id PK
        uuid project_id FK
        uuid task_id FK "nullable = project-level"
        uuid uploaded_by FK
        text original_name
        text storage_key UK
        text mime_type
        int size_bytes
        timestamptz created_at
    }
    NOTIFICATIONS {
        uuid id PK
        uuid recipient_id FK
        enum type
        uuid project_id "no FK, survives deletes"
        uuid task_id "no FK, survives deletes"
        jsonb payload "snapshot: titles, actor name"
        timestamptz read_at "nullable"
        timestamptz created_at
    }
```

### Relationship summary

- **Users ↔ Projects** is many-to-many through `project_members` (composite PK `project_id, user_id`). The `role` column lives on the membership, so a user can be OWNER of one project and MEMBER of another.
- **Ownership** is a membership role, not a column on `projects`. A partial unique index guarantees exactly one OWNER per project. `projects.created_by` is kept for audit only.
- **Tasks** belong to exactly one project. `assignee_id` is nullable and must reference a current member of that project.
- **Comments and attachments** always belong to a project. `task_id` is optional: null means project-level, set means task-level. A composite FK `(task_id, project_id) → tasks(id, project_id)` makes it impossible for a comment to point at a task in a different project.
- **Notifications** keep plain `project_id`/`task_id` columns (no FKs) plus a JSON snapshot, so history survives when a task or project is deleted.

---

## 4. Table rules

### users

- Email is trimmed and lowercased in the service before insert and lookup; unique constraint on `email`.
- `password_hash` is never returned. Repositories use an explicit `select` (a `publicUserSelect` constant) for every user read that leaves the service layer.

### refresh_tokens

- Stores only `sha256(token)`; the raw token exists only in the response.
- Cascade-deleted with the user.

### projects

- Delete is OWNER only. Cascades to members, invitations, tasks, comments, attachments. Attachment files are removed from storage after the DB transaction commits.

### project_members

- Created automatically with role OWNER for the creator, in the same transaction as the project.
- Index on `user_id` for "list my projects".
- One-owner partial unique index (Appendix B).
- Removing a member (or a member leaving) unassigns their open tasks in the same transaction. Their comments and attachments stay.
- The OWNER cannot leave or be removed; ownership must be transferred first (`PATCH member role` to OWNER demotes the current owner to ADMIN in one transaction).
- Transfer order: demote the current owner to ADMIN **first**, then promote the target. The one-owner partial unique index is checked per statement, so promoting first fails even inside the transaction. The demotion is guarded on `role = OWNER` so a concurrent transfer gets 409.
- Nobody can change their own role (409); the OWNER changes others' roles or transfers ownership.

### project_invitations

- Invite by email. The invitee may or may not have an account yet; they see it under `GET /users/me/invitations` once registered with that email.
- Only one PENDING invitation per `(project_id, email)` (partial unique index).
- Expiry is checked lazily: a PENDING invitation past `expires_at` is treated as EXPIRED. Before creating a new invite, mark stale pending rows for the same pair as EXPIRED so the unique index doesn't block it.
- Cannot invite someone who is already a member (409). Role OWNER is not allowed in invitations.
- Only the OWNER may invite with role ADMIN (ADMIN inviting an ADMIN → 403), so granting ADMIN stays owner-only, same as changing roles.
- Accept: in one transaction, set status ACCEPTED + `responded_at`, insert into `project_members`.
- Accept/decline checks, in order: invitation email ≠ caller's email → 404 (existence not revealed); not PENDING → 409; past `expires_at` → 410 `INVITATION_EXPIRED`; (accept only) already a member → 409. The status change is an `updateMany` guarded on `status = PENDING`, so only one of two concurrent responses wins.
- Revoke: only an unexpired PENDING invitation can be revoked (else 409); `responded_at` stays null because the invitee didn't respond.

### tasks

- `status = COMPLETED` ⇔ `completed_at IS NOT NULL` (check constraint). The service sets `completed_at = now()` when moving to COMPLETED and clears it when moving away.
- Postgres enums sort in declaration order, so sorting by `priority` works directly (LOW < MEDIUM < HIGH < URGENT).
- `@@unique([id, projectId])` exists only as the target for the comment/attachment composite FKs.
- Trigram GIN indexes on `title` and `description` for `ILIKE '%q%'` search.
- Indexes: `(project_id, status)`, `(assignee_id, status)`, `(project_id, due_date)`.

### comments

- Task-level comments cascade-delete with the task; project-level comments cascade with the project.
- Edit sets `edited_at`. Edit is author only; delete is author or ADMIN/OWNER.
- Index `(project_id, task_id, created_at)`.

### attachments

- `storage_key` is `<project_id>/<uuid>`, generated server-side; no part of the user's filename reaches the path, and `LocalStorage` refuses any key that resolves outside `UPLOAD_DIR`. The filename is stored only as `original_name` (basename only, control characters stripped, max 255 chars, `file` if nothing is left) and sent back in `Content-Disposition` on download.
- Max `MAX_UPLOAD_MB` (10 MB), one file per request, MIME allowlist: PNG, JPEG, GIF, WebP, PDF, plain text, CSV, zip, Word (`.doc`, `.docx`), Excel (`.xls`, `.xlsx`).
- **Known limitation:** the MIME type is the one the client declares in the multipart part. There's no magic-byte sniffing, so a renamed executable labelled `text/plain` is accepted. Downloads are always `Content-Disposition: attachment` and helmet sends `X-Content-Type-Options: nosniff`, so browsers save rather than render them.
- Upload order: task check (404 before anything is written) → write the file → insert the row; if the insert fails the file is deleted, so failed uploads leave no orphans.
- Same cascade and composite-FK rules as comments. Deleting an attachment, task or project deletes the rows first, then the files after the transaction commits; a failed file delete is logged as a warning and doesn't fail the request. Task and project deletes lock the parent row before collecting storage keys, so an upload racing the delete fails its FK check instead of leaving an untracked file.

### notifications

- Index `(recipient_id, read_at, created_at)`.
- Never notify the actor about their own action.

---

## 5. Roles and permissions

Non-members get **404** on any project resource, so project existence is not leaked. Members lacking the role get **403**.

| Action                                              |       MEMBER        | ADMIN  |        OWNER        |
| --------------------------------------------------- | :-----------------: | :----: | :-----------------: |
| View project, members, tasks, comments, attachments |         ✅          |   ✅   |         ✅          |
| Update project name/description                     |         ❌          |   ✅   |         ✅          |
| Delete project                                      |         ❌          |   ❌   |         ✅          |
| Invite / revoke invitations                         |         ❌          |   ✅   |         ✅          |
| Invite with role ADMIN                              |         ❌          |   ❌   |         ✅          |
| Remove a MEMBER                                     |         ❌          |   ✅   |         ✅          |
| Remove an ADMIN, change roles, transfer ownership   |         ❌          |   ❌   |         ✅          |
| Leave project                                       |         ✅          |   ✅   | ❌ (transfer first) |
| Create task                                         |         ✅          |   ✅   |         ✅          |
| Update / assign / complete task                     | creator or assignee |   ✅   |         ✅          |
| Delete task                                         |       creator       |   ✅   |         ✅          |
| Add comment / upload attachment                     |         ✅          |   ✅   |         ✅          |
| Edit comment                                        |       author        | author |       author        |
| Delete comment / attachment                         |   author/uploader   |   ✅   |         ✅          |

Implementation: a `loadMembership` middleware on every `/projects/:projectId/*` route fetches the caller's membership (404 if none) and puts it on `req.membership`. Row-level checks (creator, assignee, author) happen in the service, since they need the row.

---

## 6. Authentication

**Access token:** JWT, HS256, 15 min TTL, claims `sub` (user id), `iat`, `exp`. Sent as `Authorization: Bearer <token>`.

**Refresh token:** 32 random bytes (base64url), 7-day TTL, sent in the JSON body (API-only project; an httpOnly cookie is the browser-app alternative, mention it in the README).

Flows:

1. **Register** → validate, check email free (409), hash with argon2id, create user, return user (201). Does not log in automatically.
2. **Login** → look up by email. If not found, still run an argon2 verify against a dummy hash so response time doesn't reveal which emails exist. Wrong email or password both return `401 INVALID_CREDENTIALS`. On success, issue access + refresh tokens.
3. **Refresh** → hash the presented token, find the row.
   - Not found or expired → 401.
   - Found but already revoked → **reuse detected**: revoke all of that user's refresh tokens, return 401.
   - Valid → revoke it and issue a new pair (rotation).
4. **Logout** → revoke the presented refresh token (idempotent, 204). The access token stays valid until it expires (max 15 min); document this trade-off. A `jti` denylist is the upgrade path.
5. **Logout all** → revoke every refresh token for the user.
6. **Change password** → verify current password, update hash, revoke all refresh tokens.

Rate limit `/auth/*` (e.g. 10 requests/min/IP).

**Decisions and known trade-offs**

- **Login accepts any non-empty password** (1–128 chars). The 8–128 policy is enforced only at register and change-password, so a short password at login is just wrong (401 `INVALID_CREDENTIALS`), not a validation error, and tightening the policy later doesn't lock out existing accounts.
- **Refresh checks expiry before revocation.** A token that is both expired and revoked gets a plain 401 `INVALID_REFRESH_TOKEN` without triggering reuse detection.
- **Retried refreshes look like reuse.** If a client retries a refresh after the first request already succeeded (e.g. the response was lost), the retry presents a revoked token, so reuse detection revokes all of the user's sessions and they must log in again. Two refreshes that race before either commits are safe: the `revokedAt: null` guard lets exactly one rotate and the other gets 401 without the revoke-all. Clients should serialise refreshes and never retry one with the same token. A short grace window for the just-rotated token is the upgrade path.
- **Wrong current password on change-password is 400 `INVALID_CURRENT_PASSWORD`**, not 401, so clients don't mistake it for an expired session and start a token refresh.

---

## 7. API

Base path `/api/v1`. All routes except register, login, refresh, and health require a bearer token. All IDs are UUIDs, validated before hitting the DB (invalid → 422).

### Auth

| Method | Path               | Body                        | Success                                              |
| ------ | ------------------ | --------------------------- | ---------------------------------------------------- |
| POST   | `/auth/register`   | `{ email, password, name }` | 201 user                                             |
| POST   | `/auth/login`      | `{ email, password }`       | 200 `{ accessToken, refreshToken, expiresIn, user }` |
| POST   | `/auth/refresh`    | `{ refreshToken }`          | 200 new pair                                         |
| POST   | `/auth/logout`     | `{ refreshToken }`          | 204                                                  |
| POST   | `/auth/logout-all` | —                           | 204                                                  |

### Current user

| Method | Path                    | Notes                                                                                             |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/users/me`             | Profile                                                                                           |
| PATCH  | `/users/me`             | `{ name?, bio?, avatarUrl? }` (email change out of scope)                                         |
| PATCH  | `/users/me/password`    | `{ currentPassword, newPassword }` → 204; wrong current password → 400 `INVALID_CURRENT_PASSWORD` |
| GET    | `/users/me/tasks`       | Tasks assigned to me across all my projects; same query params as task list                       |
| GET    | `/users/me/invitations` | My pending, unexpired invitations                                                                 |

### Projects

| Method | Path                   | Role                                                |
| ------ | ---------------------- | --------------------------------------------------- |
| POST   | `/projects`            | any user; creator becomes OWNER                     |
| GET    | `/projects`            | projects I belong to, with my role and member count |
| GET    | `/projects/:projectId` | member                                              |
| PATCH  | `/projects/:projectId` | ADMIN+                                              |
| DELETE | `/projects/:projectId` | OWNER                                               |

### Members and invitations

| Method | Path                                             | Role                                                   |
| ------ | ------------------------------------------------ | ------------------------------------------------------ |
| GET    | `/projects/:projectId/members`                   | member                                                 |
| PATCH  | `/projects/:projectId/members/:userId`           | OWNER (`{ role }`; `OWNER` = transfer; own role → 409) |
| DELETE | `/projects/:projectId/members/:userId`           | ADMIN+ to remove; self to leave                        |
| POST   | `/projects/:projectId/invitations`               | ADMIN+ (`{ email, role }`; role ADMIN: OWNER only)     |
| GET    | `/projects/:projectId/invitations`               | ADMIN+ (`?status=`)                                    |
| DELETE | `/projects/:projectId/invitations/:invitationId` | ADMIN+ (sets REVOKED)                                  |
| POST   | `/invitations/:invitationId/accept`              | invitee (email must match)                             |
| POST   | `/invitations/:invitationId/decline`             | invitee                                                |

### Tasks

| Method | Path                                 | Notes                                                                                                                                                       |
| ------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/projects/:projectId/tasks`         | `{ title, description?, dueDate?, priority?, assigneeId? }`; no `status` (starts OPEN), `priority` defaults to MEDIUM, `dueDate` is ISO 8601 with an offset |
| GET    | `/projects/:projectId/tasks`         | filter/sort/search/paginate (below)                                                                                                                         |
| GET    | `/projects/:projectId/tasks/:taskId` | includes assignee and creator summaries, comment and attachment counts                                                                                      |
| PATCH  | `/projects/:projectId/tasks/:taskId` | any of `title, description, dueDate, priority, status, assigneeId` (`null` unassigns). Completing a task = `{ "status": "COMPLETED" }`                      |
| DELETE | `/projects/:projectId/tasks/:taskId` | 204                                                                                                                                                         |

- `assigneeId` (create or update) must be a current member of this project, else **422** `VALIDATION_ERROR` with `details[].path = "assigneeId"`.
- PATCH and DELETE check, in order: membership (404) → task belongs to this project (404) → permission (403) → body (422). The task is loaded and authorised before the body is validated, so a forbidden caller never learns about body rules.
- Completion: entering COMPLETED sets `completed_at = now()`, leaving it clears it, and a PATCH that keeps it COMPLETED keeps the original timestamp. A PATCH that sends `status` only applies if the status hasn't changed since it was read, otherwise **409**, so status and `completed_at` can't disagree under concurrent edits.

**Task list query params**

| Param                   | Example                        | Meaning                                                                                                                                                                                                 |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                | `OPEN,IN_PROGRESS`             | comma list                                                                                                                                                                                              |
| `priority`              | `HIGH,URGENT`                  | comma list                                                                                                                                                                                              |
| `assignee`              | `me` / `unassigned` / `<uuid>` | not accepted on `/users/me/tasks` (422)                                                                                                                                                                 |
| `createdBy`             | `me` / `<uuid>`                |                                                                                                                                                                                                         |
| `dueBefore`, `dueAfter` | ISO 8601 with offset           | exclusive: `due_date <` / `>` the value                                                                                                                                                                 |
| `overdue`               | `true` / `false`               | `true`: `due_date < now()` and not completed; `false`: the complement (undated, not yet due, or completed). Any other value → 422                                                                       |
| `q`                     | `login bug`                    | case-insensitive substring match on title or description                                                                                                                                                |
| `sort`                  | `dueDate`                      | one of `dueDate, createdAt, updatedAt, priority, title` (whitelist)                                                                                                                                     |
| `order`                 | `asc` / `desc`                 | default per field: `dueDate` asc, `createdAt` desc, `updatedAt` desc, `priority` desc (URGENT first), `title` asc. Default sort is `createdAt` desc. Due dates always sort nulls last; `id` breaks ties |
| `page`, `limit`         | `1`, `20`                      | limit max 100                                                                                                                                                                                           |

Unknown params and invalid values → 422. `GET /users/me/tasks` takes the same params except `assignee`; its items also include `project { id, name }`. List items carry `assignee { id, name } | null` and `createdBy { id, name }`.

### Comments

| Method | Path                                       | Notes                                                                                                                                                                       |
| ------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/projects/:projectId/comments`            | any member; `{ body, taskId? }`; `body` trimmed, 1–5000; `taskId` not in this project → 404                                                                                 |
| GET    | `/projects/:projectId/comments`            | any member sees all comments; `?taskId=<uuid>` for one task (404 if not in this project), `?taskId=none` for project-level only; oldest first (`id` breaks ties); paginated |
| GET    | `/projects/:projectId/comments/:commentId` | any member; the comment plus `task { id, title, description } \| null` and `project { id, name }`                                                                           |
| PATCH  | `/projects/:projectId/comments/:commentId` | author only (ADMIN/OWNER can't edit others'); `{ body }`; sets `editedAt`                                                                                                   |
| DELETE | `/projects/:projectId/comments/:commentId` | author or ADMIN+                                                                                                                                                            |

POST, PATCH and list items return the comment fields (`id, projectId, taskId, authorId, body, editedAt, createdAt`) plus `author { id, name }`. List query params other than `taskId`, `page`, `limit` → 422. A comment from another project → 404. PATCH and DELETE check, in order: comment exists in this project (404) → permission (403) → body (422).

### Attachments

| Method | Path                                                      | Notes                                                                                                                                                                                                |
| ------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/projects/:projectId/attachments`                        | any member; `multipart/form-data`: `file` (exactly one), optional `taskId` (404 if not in this project); 201 `{ id, originalName, mimeType, sizeBytes, taskId, createdAt, uploadedBy { id, name } }` |
| GET    | `/projects/:projectId/attachments`                        | any member; `?taskId=<uuid>` / `none` as for comments (404 if not in this project); unknown params → 422; newest first (`id` breaks ties); paginated; metadata only                                  |
| GET    | `/projects/:projectId/attachments/:attachmentId`          | any member; metadata (same shape as POST)                                                                                                                                                            |
| GET    | `/projects/:projectId/attachments/:attachmentId/download` | any member; streams the file with the stored `Content-Type`, `Content-Length` and `Content-Disposition: attachment` (UTF-8 names encoded as `filename*`); file missing from storage → 404            |
| DELETE | `/projects/:projectId/attachments/:attachmentId`          | uploader or ADMIN+ (else 403); row, then file; 204                                                                                                                                                   |

### Notifications (optional)

| Method | Path                                  | Notes                                                              |
| ------ | ------------------------------------- | ------------------------------------------------------------------ |
| GET    | `/notifications`                      | `?unread=true\|false`, paginated, newest first; `meta.unreadCount` |
| GET    | `/notifications/stream`               | SSE stream                                                         |
| PATCH  | `/notifications/:notificationId/read` | 204, idempotent; not mine → 404                                    |
| POST   | `/notifications/read-all`             | 204                                                                |

### AI (optional)

| Method | Path                   | Notes                                                                                                                                                                                                                      |
| ------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/ai/task-description` | any signed-in user; strict `{ title (trim, 1–200), notes? (trim, ≤ 2000) }` → `{ description }`; 10/min per user; 503 `AI_DISABLED` when no provider is configured; 502 `AI_UPSTREAM_ERROR` on provider failure or timeout |

### Health

`GET /health` → `{ status: "ok", db: "ok" }` (runs `SELECT 1`).

---

## 8. Response and error format

Success:

```json
{ "data": { ... } }
{ "data": [ ... ], "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 } }
```

Error:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "dueDate", "message": "Invalid ISO date" }],
    "requestId": "c0a8..."
  }
}
```

| HTTP | `code`                                                   | When                                                                                                                 |
| ---- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 400  | `BAD_REQUEST`                                            | Malformed JSON, invalid multipart (incl. a second file or a file field other than `file`)                            |
| 400  | `INVALID_CURRENT_PASSWORD`                               | Change-password with a wrong current password                                                                        |
| 401  | `UNAUTHORIZED` / `INVALID_CREDENTIALS` / `TOKEN_EXPIRED` | Missing/invalid token, bad login                                                                                     |
| 401  | `INVALID_REFRESH_TOKEN`                                  | Refresh token unknown, expired, revoked or reused                                                                    |
| 403  | `FORBIDDEN`                                              | Member lacks role or row ownership                                                                                   |
| 404  | `NOT_FOUND`                                              | Missing resource, or caller not a member                                                                             |
| 409  | `CONFLICT`                                               | Email taken, already a member, pending invite exists, owner leaving, changing own role, invitation no longer pending |
| 410  | `INVITATION_EXPIRED`                                     | Accepting or declining an invitation past `expires_at`                                                               |
| 413  | `PAYLOAD_TOO_LARGE`                                      | Upload over `MAX_UPLOAD_MB`, or JSON body over 1 MB                                                                  |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                                 | Declared MIME type not in the allowlist                                                                              |
| 422  | `VALIDATION_ERROR`                                       | Zod failure on body, params, or query                                                                                |
| 429  | `RATE_LIMITED`                                           | Rate limit hit                                                                                                       |
| 500  | `INTERNAL_ERROR`                                         | Anything unexpected (log full error; never send stack traces)                                                        |
| 502  | `AI_UPSTREAM_ERROR`                                      | AI provider error, empty answer or 10 s timeout (details logged, never returned)                                     |
| 503  | `AI_DISABLED`                                            | AI endpoint with no provider configured (`AI_PROVIDER` empty)                                                        |

Implementation: an `AppError` base class with subclasses (`NotFoundError`, `ForbiddenError`, `ConflictError`, …). The error middleware maps `AppError`, `ZodError`, multer errors, and Prisma `P2002` (unique violation → 409) / `P2025` (not found → 404); everything else is 500.

**Validation limits:** name 1–100, email valid and ≤ 254, password 8–128, project name 1–100, title 1–200, description ≤ 5000, comment body 1–5000, bio ≤ 500. Unknown body fields are rejected (`.strict()`).

---

## 9. Notifications (optional)

1. Services publish domain events on a typed in-process bus (`src/lib/events.ts`) **after their write has committed**, never inside `$transaction`: `task.assigned`, `task.updated`, `task.completed`, `comment.created`, `invitation.created`.
2. `publish()` **awaits** every handler in turn, each in its own try/catch: a failing handler is logged and never reaches the caller, so a notification problem can't fail or roll back a request. The cost is that notification work adds to the request's latency; a queue (or not awaiting) is the upgrade path if that matters.
3. **One event per task change**, most specific first: task created with an assignee, or PATCH sets `assigneeId` to a different, non-null user → `task.assigned`; else PATCH moves `status` to COMPLETED → `task.completed`; else any field whose value actually changed → `task.updated` with `changedFields`. Unassigning (`assigneeId: null`) counts as an update; a PATCH whose values are all unchanged publishes nothing.
4. The notifications listener decides recipients, **never the actor**, de-duplicated:

   | Event                       | Recipients                                 | Type                 |
   | --------------------------- | ------------------------------------------ | -------------------- |
   | `task.assigned`             | the assignee                               | `TASK_ASSIGNED`      |
   | `task.completed`            | task creator, assignee                     | `TASK_COMPLETED`     |
   | `task.updated`              | task creator, assignee                     | `TASK_UPDATED`       |
   | `comment.created` (task)    | task creator, assignee                     | `COMMENT_ADDED`      |
   | `comment.created` (project) | nobody                                     | —                    |
   | `invitation.created`        | the account with that email, if one exists | `PROJECT_INVITATION` |

   It inserts the rows, then pushes each to the recipient's open SSE streams. The `payload` is a snapshot taken at event time, so later renames don't rewrite history: `actor { id, name }`, `project { id, name }`, `task { id, title }` for task events, plus `changedFields`, `commentId` + `commentPreview` (first 140 characters), or `invitationId` + `role`.

5. Registration is idempotent (`createApp()` calls it; tests build many apps).
6. SSE: `GET /notifications/stream` sends `text/event-stream` with `Cache-Control: no-cache`, `X-Accel-Buffering: no`, an initial `event: ready`, then `id: <notificationId>` / `event: notification` / `data: <json>` frames, and a `: ping` comment every 25 s to keep proxies from closing idle connections. Registry: `Map<userId, Set<Response>>`; a response is removed (and its timer cleared) on `close`. On shutdown, `closeAllStreams()` ends every stream before `server.close()` so they don't block a graceful exit.
7. Missed events while offline are available from `GET /notifications` (`?unread=true|false`; `meta` adds `unreadCount`). Marking one read is idempotent and keeps the first `read_at`; someone else's notification is 404.

**Limitation:** the SSE registry and the event bus are in memory, so live pushes reach only clients connected to the same instance as the request that caused them. Scaling out needs Redis pub/sub (or similar) between instances; the stored notifications are unaffected.

SSE auth: browsers' `EventSource` can't send an `Authorization` header. For this API, clients use a fetch-based SSE reader (or curl) with the header. Mention a short-lived `?token=` ticket as the browser-friendly alternative in the README.

---

## 10. AI task description (optional)

- `AiProvider` interface: `generateTaskDescription({ title, notes? }): Promise<string>`. **Two real implementations**, chosen by `AI_PROVIDER`, so output quality and cost can be compared by changing config only: `anthropic` (official `@anthropic-ai/sdk`) and `gemini` (official `@google/genai`). Both take the model from `AI_MODEL`; no model id is hardcoded. A `FakeAiProvider` returns a deterministic description built from the input for tests.
- Config: if `AI_PROVIDER` is set, `AI_API_KEY` and `AI_MODEL` are required (the app refuses to boot otherwise); empty `AI_PROVIDER` disables the feature (503 `AI_DISABLED`).
- Registry: `getAiProvider()` builds the configured provider lazily (or returns null); `setAiProvider()` overrides it in tests. Under `NODE_ENV=test` the configured provider is always null, so tests can't reach a real API even if `.env` holds a key.
- Prompt (shared by both providers): the system instruction asks for plain text, one goal sentence, then 3–6 acceptance criteria as `- ` bullets, about 150 words, no headings or preamble. Title and notes go in the user turn inside `<title>` / `<notes>` tags, and the model is told to treat that content as data, never instructions. Any `<title>`/`<notes>` tags inside the user's text (including spaced variants like `< /notes >`) are stripped so the data can't close its block early.
- Output is trimmed and capped at 5000 characters (the task description limit); an empty answer is a 502.
- 10 s budget per call: the Anthropic client uses a 10 s timeout with retries off (the SDK otherwise retries, multiplying the wait); Gemini uses a 10 s HTTP timeout plus an abort signal. A Claude `refusal` stop reason, an empty Gemini answer, a timeout or any SDK error map to 502 `AI_UPSTREAM_ERROR`; the underlying error is logged with the provider name and never returned.
- Rate limit: 10 requests/min **per user** (keyed by the authenticated user id, not the IP), via `createRateLimiter({ keyGenerator: byUserId })`; skipped under `NODE_ENV=test` like the auth limiter.
- The endpoint only suggests text; the client still creates or updates the task through the normal endpoints.

---

## 11. Security checklist

- [ ] helmet, CORS restricted by `CORS_ORIGIN`, JSON body limit 1 MB
- [ ] argon2id hashing; dummy verify on unknown email
- [ ] Refresh tokens hashed at rest, rotated, reuse detection
- [ ] Rate limits on auth and AI routes
- [ ] Non-members get 404
- [ ] `password_hash` excluded by explicit selects
- [ ] Upload size limit, MIME allowlist, random storage keys, `Content-Disposition: attachment` on download (MIME is client-declared, not sniffed; storage refuses keys outside `UPLOAD_DIR`)
- [ ] Env validated at boot with Zod; app refuses to start on missing secrets
- [ ] No stack traces in responses
- [ ] `.env` gitignored, `.env.example` committed

---

## 12. Project structure

```
taskmaster/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── src/
│   ├── app.ts                 # builds the Express app (no listen) — imported by tests
│   ├── server.ts              # listen + graceful shutdown
│   ├── config/env.ts          # Zod-validated env
│   ├── db/prisma.ts
│   ├── lib/
│   │   ├── errors.ts          # AppError hierarchy
│   │   ├── jwt.ts
│   │   ├── password.ts
│   │   ├── pagination.ts
│   │   ├── events.ts          # typed in-process event bus
│   │   └── storage/           # StorageDriver interface + LocalStorage
│   ├── middleware/
│   │   ├── authenticate.ts
│   │   ├── loadMembership.ts
│   │   ├── requireRole.ts
│   │   ├── validate.ts        # validate({ body, params, query }) → req.validated
│   │   ├── upload.ts
│   │   ├── rateLimit.ts
│   │   └── errorHandler.ts
│   ├── modules/
│   │   ├── auth/              # *.routes.ts, *.controller.ts, *.service.ts, *.repository.ts, *.schemas.ts
│   │   ├── users/
│   │   ├── projects/
│   │   ├── members/           # members + invitations
│   │   ├── tasks/
│   │   ├── comments/
│   │   ├── attachments/
│   │   ├── notifications/
│   │   └── ai/
│   └── types/express.d.ts     # req.user, req.membership, req.validated
├── tests/
│   ├── helpers/               # app instance, DB reset, factories, auth helper
│   ├── integration/
│   └── unit/
├── docs/DESIGN.md
├── docker-compose.yml         # postgres:18.3 (+ app)
├── Dockerfile
├── .env.example
├── .github/workflows/ci.yml
└── README.md
```

---

## 13. Testing strategy

- **Integration tests (most value):** supertest against `app` with a real Postgres test database. Truncate all tables before each test file (`TRUNCATE ... RESTART IDENTITY CASCADE`). Run test files sequentially so they don't fight over the DB.
- **Factories:** `createUser()`, `loginAs(user)`, `createProject(owner)`, `addMember(project, user, role)`, `createTask(...)`.
- **Dates:** build them relative to "now" (e.g. `addDays(new Date(), 3)`), never hardcoded.
- **AI:** always the fake provider in tests.
- **Must-have cases:**
  - Auth: register duplicate → 409; login wrong password → 401; refresh rotation; reused refresh token revokes all; logout then refresh → 401.
  - Permissions: non-member → 404; MEMBER deleting someone else's task → 403; ADMIN removing ADMIN → 403; owner leaving → 409.
  - Tasks: assign to non-member → 422/409; complete sets `completed_at`; reopen clears it; each filter, sort, `q`, pagination meta; `/users/me/tasks` spans projects.
  - Invitations: duplicate pending → 409; accept adds membership; wrong user accepting → 404; expired → 410 `INVITATION_EXPIRED`.
  - Comments/attachments: `taskId` from another project → 404; oversize upload → 413; bad MIME → 415.
  - Member removal unassigns their tasks.
- **CI:** GitHub Actions with a `postgres:18.3` service container → install → `prisma migrate deploy` → lint → typecheck → test.

---

## 14. Build plan (in order)

Each step ends with tests passing and a commit. Don't start the next step with a red build.

### Day 1 — Sun 18 Oct: foundation, schema, auth

1. **Scaffold** (~1.5 h)
   `npm init`, TypeScript strict, `express@5.3.0`, ESLint + Prettier, tsx watch script, `config/env.ts`, `docker-compose.yml` with `postgres:18.3` (volume at `/var/lib/postgresql`), `app.ts`/`server.ts` split, pino-http, `GET /health`, error handler stub, Vitest + supertest with one health test, CI workflow.
   _Done when:_ `docker compose up -d && npm test` is green locally and in CI.

2. **Schema and migration** (~1.5 h)
   Write `schema.prisma` (Appendix A). `npx prisma migrate dev --create-only --name init`, append Appendix B SQL to the generated migration, then `npx prisma migrate dev`. Write `seed.ts` (2 users, 1 project, a few tasks).
   _Done when:_ migration applies on a clean DB and seed runs.

3. **Shared plumbing** (~1 h)
   `AppError` hierarchy, full error middleware (Zod, Prisma, multer mapping), `validate()` middleware, response helpers, pagination helper, `express.d.ts`.

4. **Auth module** (~2.5 h)
   Register, login, refresh with rotation and reuse detection, logout, logout-all, `authenticate` middleware, auth rate limit, tests.

5. **Profile** (~1 h)
   `GET/PATCH /users/me`, change password (revokes refresh tokens), tests.

### Day 2 — Mon 19 Oct: collaboration core

6. **Projects** (~1.5 h)
   CRUD, owner membership created in the same transaction, `loadMembership` + `requireRole` middleware, tests including non-member 404.

7. **Members and invitations** (~2.5 h)
   List/remove/leave/change role/transfer ownership; invite, list, revoke, accept, decline, `/users/me/invitations`; member removal unassigns tasks; tests.

8. **Tasks** (~3.5 h)
   CRUD, assignment validation, completion logic, permission rules, list with all filters/sort/search/pagination, `/users/me/tasks`, tests.

9. **Comments** (~1 h)
   CRUD with project/task scoping and permission rules, tests.

### Day 3 — Tue 20 Oct: files, extras, submission

10. **Attachments** (~2 h)
    `StorageDriver` + `LocalStorage`, multer config, upload/list/download/delete, file cleanup on task/project delete, tests.

11. **Notifications** (~2 h, optional)
    Event bus, listener, persistence, list/read endpoints, SSE stream.

12. **AI description** (~1 h, optional)
    Provider interface, real + fake implementation, endpoint, tests with the fake.

13. **Docs and submission** (~2 h)
    README, Postman collection or OpenAPI file, final CI run, Dockerfile check, make repo public, submit.

**Cut line:** if you're behind at the start of Day 3, drop step 12, then the SSE stream from step 11 (keep it as a documented future extension). Never cut tests for core features or the README.

---

## 15. README checklist

- One-paragraph overview and feature list mapped to the user stories
- Tech stack and the key decisions from §2 (one line each)
- ER diagram (paste the Mermaid block; GitHub renders it)
- Setup: prerequisites, `cp .env.example .env`, `docker compose up -d`, `npm i`, `npx prisma migrate dev`, `npm run seed`, `npm run dev`
- Running tests
- API overview table and a link to the Postman/OpenAPI file
- Auth flow explanation, including the logout trade-off
- Permissions matrix
- Known limitations and next steps (single-instance SSE, local file storage, no email delivery, access-token denylist)

---

## Appendix A — Prisma schema

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum ProjectRole {
  OWNER
  ADMIN
  MEMBER
}

enum InvitationStatus {
  PENDING
  ACCEPTED
  DECLINED
  REVOKED
  EXPIRED
}

enum TaskStatus {
  OPEN
  IN_PROGRESS
  COMPLETED
}

enum TaskPriority {
  LOW
  MEDIUM
  HIGH
  URGENT
}

enum NotificationType {
  TASK_ASSIGNED
  TASK_UPDATED
  TASK_COMPLETED
  COMMENT_ADDED
  PROJECT_INVITATION
}

model User {
  id           String   @id @default(uuid()) @db.Uuid
  email        String   @unique
  passwordHash String   @map("password_hash")
  name         String   @db.VarChar(100)
  bio          String?  @db.VarChar(500)
  avatarUrl    String?  @map("avatar_url")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  refreshTokens   RefreshToken[]
  createdProjects Project[]           @relation("ProjectCreator")
  memberships     ProjectMember[]
  sentInvitations ProjectInvitation[] @relation("InvitedBy")
  createdTasks    Task[]              @relation("TaskCreator")
  assignedTasks   Task[]              @relation("TaskAssignee")
  comments        Comment[]
  attachments     Attachment[]
  notifications   Notification[]

  @@map("users")
}

model RefreshToken {
  id        String    @id @default(uuid()) @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  tokenHash String    @unique @map("token_hash")
  userAgent String?   @map("user_agent")
  expiresAt DateTime  @map("expires_at") @db.Timestamptz(6)
  revokedAt DateTime? @map("revoked_at") @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("refresh_tokens")
}

model Project {
  id          String   @id @default(uuid()) @db.Uuid
  name        String   @db.VarChar(100)
  description String?
  createdById String   @map("created_by") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  createdBy   User                @relation("ProjectCreator", fields: [createdById], references: [id], onDelete: Restrict)
  members     ProjectMember[]
  invitations ProjectInvitation[]
  tasks       Task[]
  comments    Comment[]
  attachments Attachment[]

  @@map("projects")
}

model ProjectMember {
  projectId String      @map("project_id") @db.Uuid
  userId    String      @map("user_id") @db.Uuid
  role      ProjectRole @default(MEMBER)
  joinedAt  DateTime    @default(now()) @map("joined_at") @db.Timestamptz(6)

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([projectId, userId])
  @@index([userId])
  @@map("project_members")
}

model ProjectInvitation {
  id          String           @id @default(uuid()) @db.Uuid
  projectId   String           @map("project_id") @db.Uuid
  email       String
  role        ProjectRole      @default(MEMBER)
  status      InvitationStatus @default(PENDING)
  invitedById String           @map("invited_by") @db.Uuid
  expiresAt   DateTime         @map("expires_at") @db.Timestamptz(6)
  respondedAt DateTime?        @map("responded_at") @db.Timestamptz(6)
  createdAt   DateTime         @default(now()) @map("created_at") @db.Timestamptz(6)

  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  invitedBy User    @relation("InvitedBy", fields: [invitedById], references: [id], onDelete: Cascade)

  @@index([email, status])
  @@index([projectId, status])
  @@map("project_invitations")
}

model Task {
  id          String       @id @default(uuid()) @db.Uuid
  projectId   String       @map("project_id") @db.Uuid
  title       String       @db.VarChar(200)
  description String?
  status      TaskStatus   @default(OPEN)
  priority    TaskPriority @default(MEDIUM)
  dueDate     DateTime?    @map("due_date") @db.Timestamptz(6)
  createdById String       @map("created_by") @db.Uuid
  assigneeId  String?      @map("assignee_id") @db.Uuid
  completedAt DateTime?    @map("completed_at") @db.Timestamptz(6)
  createdAt   DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime     @updatedAt @map("updated_at") @db.Timestamptz(6)

  project     Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  createdBy   User         @relation("TaskCreator", fields: [createdById], references: [id], onDelete: Restrict)
  assignee    User?        @relation("TaskAssignee", fields: [assigneeId], references: [id], onDelete: SetNull)
  comments    Comment[]
  attachments Attachment[]

  @@unique([id, projectId])
  @@index([projectId, status])
  @@index([assigneeId, status])
  @@index([projectId, dueDate])
  @@index([title(ops: raw("gin_trgm_ops"))], type: Gin, map: "tasks_title_trgm_idx")
  @@index([description(ops: raw("gin_trgm_ops"))], type: Gin, map: "tasks_description_trgm_idx")
  @@map("tasks")
}

model Comment {
  id        String    @id @default(uuid()) @db.Uuid
  projectId String    @map("project_id") @db.Uuid
  taskId    String?   @map("task_id") @db.Uuid
  authorId  String    @map("author_id") @db.Uuid
  body      String
  editedAt  DateTime? @map("edited_at") @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  // Composite FK: a task-level comment must point at a task in the same project.
  task    Task?   @relation(fields: [taskId, projectId], references: [id, projectId], onDelete: Cascade)
  author  User    @relation(fields: [authorId], references: [id], onDelete: Restrict)

  @@index([projectId, taskId, createdAt])
  @@map("comments")
}

model Attachment {
  id           String   @id @default(uuid()) @db.Uuid
  projectId    String   @map("project_id") @db.Uuid
  taskId       String?  @map("task_id") @db.Uuid
  uploadedById String   @map("uploaded_by") @db.Uuid
  originalName String   @map("original_name")
  storageKey   String   @unique @map("storage_key")
  mimeType     String   @map("mime_type")
  sizeBytes    Int      @map("size_bytes")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  project    Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  task       Task?   @relation(fields: [taskId, projectId], references: [id, projectId], onDelete: Cascade)
  uploadedBy User    @relation(fields: [uploadedById], references: [id], onDelete: Restrict)

  @@index([projectId, taskId])
  @@map("attachments")
}

model Notification {
  id          String           @id @default(uuid()) @db.Uuid
  recipientId String           @map("recipient_id") @db.Uuid
  type        NotificationType
  projectId   String?          @map("project_id") @db.Uuid
  taskId      String?          @map("task_id") @db.Uuid
  payload     Json             @default("{}")
  readAt      DateTime?        @map("read_at") @db.Timestamptz(6)
  createdAt   DateTime         @default(now()) @map("created_at") @db.Timestamptz(6)

  recipient User @relation(fields: [recipientId], references: [id], onDelete: Cascade)

  @@index([recipientId, readAt, createdAt])
  @@map("notifications")
}
```

**If Prisma rejects the composite `task` relation** on `Comment`/`Attachment` (a scalar shared between two relations), fall back to `task Task? @relation(fields: [taskId], references: [id], onDelete: Cascade)` and enforce "task belongs to this project" in the service. Mention which one you used in the README.

---

## Appendix B — Raw SQL to append to the init migration

```sql
-- Search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Also declared in schema.prisma (Task @@index type: Gin) so Prisma doesn't try to drop them.
CREATE INDEX tasks_title_trgm_idx       ON tasks USING gin (title gin_trgm_ops);
CREATE INDEX tasks_description_trgm_idx ON tasks USING gin (description gin_trgm_ops);

-- Exactly one owner per project
CREATE UNIQUE INDEX project_members_one_owner_idx
  ON project_members (project_id) WHERE role = 'OWNER';

-- One pending invite per project + email
CREATE UNIQUE INDEX project_invitations_one_pending_idx
  ON project_invitations (project_id, email) WHERE status = 'PENDING';

-- Invitations can't grant ownership
ALTER TABLE project_invitations
  ADD CONSTRAINT project_invitations_role_not_owner CHECK (role <> 'OWNER');

-- completed_at is set exactly when status is COMPLETED
ALTER TABLE tasks
  ADD CONSTRAINT tasks_completed_at_consistent
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL));

ALTER TABLE attachments
  ADD CONSTRAINT attachments_size_positive CHECK (size_bytes > 0);
```

Prisma ignores the partial unique indexes and CHECK constraints, and the trigram indexes are declared in schema.prisma, so later `prisma migrate dev` runs shouldn't try to drop any of these. Still use `--create-only` and skim the SQL before applying. After each future `prisma migrate dev`, open the generated SQL and make sure it doesn't try to drop any of these; delete such lines if it does.

---

## Appendix C — Environment variables

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://taskmaster:taskmaster@localhost:5432/taskmaster
JWT_ACCESS_SECRET=change-me-at-least-32-chars
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=7
INVITATION_TTL_DAYS=7
CORS_ORIGIN=http://localhost:5173
UPLOAD_DIR=./uploads
MAX_UPLOAD_MB=10
AI_PROVIDER=          # anthropic | gemini; empty disables AI
AI_API_KEY=
AI_MODEL=             # required when AI_PROVIDER is set
```
