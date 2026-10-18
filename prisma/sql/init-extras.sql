-- Extras Prisma can't express in schema.prisma (extension, trigram indexes, partial
-- unique indexes, CHECK constraints).
--
-- How to apply (once, for the init migration):
--   1. npx prisma migrate dev --create-only --name init
--   2. Paste everything below at the end of prisma/migrations/<timestamp>_init/migration.sql
--   3. npx prisma migrate dev
--
-- After every later `prisma migrate dev`, check the generated SQL doesn't DROP any of these.

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
