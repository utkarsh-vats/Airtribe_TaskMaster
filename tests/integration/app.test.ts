import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';

const app = createApp();

afterAll(async () => {
    await prisma.$disconnect();
});

describe('GET /health', () => {
    it('reports ok when the database is reachable', async () => {
        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: { status: 'ok', db: 'ok' } });
    });

    it('returns a generated X-Request-Id header', async () => {
        const res = await request(app).get('/health');

        expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('echoes an incoming X-Request-Id', async () => {
        const res = await request(app).get('/health').set('X-Request-Id', 'trace-abc-123');

        expect(res.headers['x-request-id']).toBe('trace-abc-123');
    });
});

describe('error handling', () => {
    it('returns 404 in the standard error shape for unknown routes', async () => {
        const res = await request(app).get('/api/v1/does-not-exist');

        expect(res.status).toBe(404);
        expect(res.body.error).toMatchObject({
            code: 'NOT_FOUND',
            message: 'Route GET /api/v1/does-not-exist not found',
        });
        expect(typeof res.body.error.requestId).toBe('string');
    });

    it('returns 400 for a malformed JSON body', async () => {
        const res = await request(app)
            .post('/api/v1/anything')
            .set('Content-Type', 'application/json')
            .send('{"title": ');

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    it('sets security headers', async () => {
        const res = await request(app).get('/health');

        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-powered-by']).toBeUndefined();
    });
});
