import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env';
import { TooManyRequestsError } from '../lib/errors';
import { currentUserId } from './authenticate';

export interface RateLimiterOptions {
    windowMs: number;
    limit: number;
    /** Defaults to true so integration tests aren't throttled. Tests of the limiter pass false. */
    skipInTest?: boolean;
    /** Bucket key; defaults to the client IP. Use `byUserId` behind `authenticate`. */
    keyGenerator?: (req: Request) => string;
}

/** Per-user bucket key. Only valid after `authenticate` has set req.user. */
export const byUserId = (req: Request): string => `user:${currentUserId(req)}`;

/** Rate limiter (per IP unless `keyGenerator` says otherwise) answering 429 RATE_LIMITED. */
export function createRateLimiter({
    windowMs,
    limit,
    skipInTest = true,
    keyGenerator,
}: RateLimiterOptions) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        ...(keyGenerator ? { keyGenerator } : {}),
        skip: () => skipInTest && env.NODE_ENV === 'test',
        handler: (_req, _res, next) => {
            next(new TooManyRequestsError());
        },
    });
}
