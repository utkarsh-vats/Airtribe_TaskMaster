// Request augmentations live here. pino-http already adds `req.id` and `req.log`.
import type { ProjectRole, TaskStatus } from '@prisma/client';

declare global {
    namespace Express {
        interface Request {
            /** Set by `authenticate` once the bearer token is verified. */
            user?: { id: string };
            /** Set by `loadMembership` on project routes. Read it with `currentMembership()`. */
            membership?: { projectId: string; userId: string; role: ProjectRole };
            /** Set by the tasks module's `loadTask()` once the caller may act on the task. */
            task?: {
                id: string;
                createdById: string;
                assigneeId: string | null;
                status: TaskStatus;
            };
            /** Set by the comments module's `loadComment()` once the caller may act on the comment. */
            comment?: {
                id: string;
                projectId: string;
                taskId: string | null;
                authorId: string;
            };
            /** Set by the attachments module's `loadAttachment()` once the caller may act on it. */
            attachment?: {
                id: string;
                projectId: string;
                uploadedById: string;
                storageKey: string;
            };
            /** Set by `validate()`. Read it with `getValidated()` rather than directly. */
            validated?: { body?: unknown; params?: unknown; query?: unknown };
        }
    }
}

export {};
