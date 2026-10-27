# CLAUDE.md

## Running tests

- Never run tests in the background, and never start two test runs at once. Every run uses the same `_test` database, and `resetDb()` truncates it before each test, so overlapping runs delete each other's data and fail with misleading errors (e.g. foreign-key violations on rows that were just created).
- Run them in the foreground, one at a time: `npm test` for the full suite, or `npx dotenv -e .env.test -e .env -- vitest run <file>` for one file.
