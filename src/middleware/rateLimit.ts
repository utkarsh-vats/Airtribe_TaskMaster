import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env';
import { TooManyRequestsError } from '../lib/errors';

/** Per-IP limiter that answers in the standard error shape. Disabled under test. */
export function createRateLimit({ windowMs, limit }: { windowMs: number; limit: number }) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skip: () => env.NODE_ENV === 'test',
        handler: (_req, _res, next) => {
            next(new TooManyRequestsError());
        },
    });
}

export const authRateLimit = createRateLimit({ windowMs: 60_000, limit: 10 });
