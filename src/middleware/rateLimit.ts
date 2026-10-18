import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env';
import { TooManyRequestsError } from '../lib/errors';

export interface RateLimiterOptions {
    windowMs: number;
    limit: number;
    /** Defaults to true so integration tests aren't throttled. Tests of the limiter pass false. */
    skipInTest?: boolean;
}

/** Per-IP limiter that answers 429 RATE_LIMITED in the standard error shape. */
export function createRateLimiter({ windowMs, limit, skipInTest = true }: RateLimiterOptions) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skip: () => skipInTest && env.NODE_ENV === 'test',
        handler: (_req, _res, next) => {
            next(new TooManyRequestsError());
        },
    });
}
