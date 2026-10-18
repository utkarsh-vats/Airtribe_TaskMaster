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

## Configuration

`DATABASE_URL` is assembled from the `POSTGRES_*` variables in `.env` (via dotenv-expand), so the credentials live in one place and Docker Compose reads the same values. Keep `POSTGRES_PASSWORD` URL-safe (letters, digits, `-`, `_`).

## Scripts

| Script                            | What it does                         |
| --------------------------------- | ------------------------------------ |
| `npm run dev`                     | Start with hot reload                |
| `npm run build` / `npm start`     | Compile to `dist/` and run it        |
| `npm run lint` / `npm run format` | ESLint / Prettier                    |
| `npm run typecheck`               | TypeScript without emitting          |
| `npm run db:migrate`              | Create and apply a migration (dev)   |
| `npm run db:studio`               | Browse the database in Prisma Studio |
