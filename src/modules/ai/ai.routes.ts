import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { byUserId, createRateLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import * as aiController from './ai.controller';
import { taskDescriptionBodySchema } from './ai.schemas';

export const aiRouter = Router();

aiRouter.use(authenticate);

// 10 requests per minute per user (DESIGN §10), after authenticate so the key is the user id.
// Skipped under NODE_ENV=test.
aiRouter.post(
    '/task-description',
    createRateLimiter({ windowMs: 60_000, limit: 10, keyGenerator: byUserId }),
    validate({ body: taskDescriptionBodySchema }),
    aiController.suggestTaskDescription,
);
