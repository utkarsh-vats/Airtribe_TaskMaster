// Request augmentations live here. pino-http already adds `req.id` and `req.log`.
import type { ProjectRole } from '@prisma/client';

declare global {
    namespace Express {
        interface Request {
            /** Set by `authenticate` once the bearer token is verified. */
            user?: { id: string };
            /** Set by `loadMembership` on project routes. Read it with `currentMembership()`. */
            membership?: { projectId: string; userId: string; role: ProjectRole };
            /** Set by `validate()`. Read it with `getValidated()` rather than directly. */
            validated?: { body?: unknown; params?: unknown; query?: unknown };
        }
    }
}

export {};
