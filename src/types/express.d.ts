// Request augmentations live here. pino-http already adds `req.id` and `req.log`.
// Later steps add `membership?: { role: ProjectRole }` (set by loadMembership).

declare global {
    namespace Express {
        interface Request {
            /** Set by `authenticate` once the bearer token is verified. */
            user?: { id: string };
            /** Set by `validate()`. Read it with `getValidated()` rather than directly. */
            validated?: { body?: unknown; params?: unknown; query?: unknown };
        }
    }
}

export {};
