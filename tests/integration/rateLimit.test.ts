import express from 'express';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { logger } from '../../src/lib/logger';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createRateLimiter } from '../../src/middleware/rateLimit';

/** A minimal app with only the limiter, so the real auth limits (skipped in tests) stay out of it. */
function buildApp() {
    const app = express();
    app.use(pinoHttp({ logger }));
    app.use(createRateLimiter({ windowMs: 60_000, limit: 2, skipInTest: false }));
    app.get('/ping', (_req, res) => {
        res.json({ data: 'pong' });
    });
    app.use(errorHandler);
    return app;
}

describe('createRateLimiter', () => {
    it('returns 429 RATE_LIMITED in the standard error shape once the limit is hit', async () => {
        const app = buildApp();

        expect((await request(app).get('/ping')).status).toBe(200);
        expect((await request(app).get('/ping')).status).toBe(200);
        const res = await request(app).get('/ping');

        expect(res.status).toBe(429);
        expect(res.body).toEqual({
            error: {
                code: 'RATE_LIMITED',
                message: expect.any(String),
                requestId: expect.any(String),
            },
        });
        expect(res.headers['ratelimit-policy']).toBeDefined();
    });

    it('is skipped under NODE_ENV=test by default', async () => {
        const app = express();
        app.use(createRateLimiter({ windowMs: 60_000, limit: 1 }));
        app.get('/ping', (_req, res) => {
            res.json({ data: 'pong' });
        });

        for (let i = 0; i < 3; i++) {
            expect((await request(app).get('/ping')).status).toBe(200);
        }
    });
});
