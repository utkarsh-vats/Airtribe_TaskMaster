/*
  Warnings:

  - A unique constraint covering the columns `[id,project_id]` on the table `attachments` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[id,project_id]` on the table `comments` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'COMMENT_REPLY';

-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "parent_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "attachments_id_project_id_key" ON "attachments"("id", "project_id");

-- CreateIndex
CREATE INDEX "comments_parent_id_created_at_idx" ON "comments"("parent_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "comments_id_project_id_key" ON "comments"("id", "project_id");

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_project_id_fkey" FOREIGN KEY ("parent_id", "project_id") REFERENCES "comments"("id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE;
