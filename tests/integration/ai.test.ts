import { randomUUID } from 'node:crypto';
import express from 'express';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { signAccessToken } from '../../src/lib/jwt';
import { logger } from '../../src/lib/logger';
import { authenticate } from '../../src/middleware/authenticate';
import { errorHandler } from '../../src/middleware/errorHandler';
import { byUserId, createRateLimiter } from '../../src/middleware/rateLimit';
import type { AiProvider } from '../../src/modules/ai/ai.provider';
import { getAiProvider, setAiProvider } from '../../src/modules/ai/ai.registry';
import { FakeAiProvider } from '../../src/modules/ai/providers/fake.provider';

const app = createApp();
const URL = '/api/v1/ai/task-description';

// authenticate does no DB lookup, so a signed token for a random id is enough here.
const bearer = (userId: string = randomUUID()) => `Bearer ${signAccessToken(userId).token}`;

afterEach(() => {
    setAiProvider(undefined);
});

afterAll(async () => {
    await prisma.$disconnect();
});

describe('POST /api/v1/ai/task-description', () => {
    it('returns a description built by the provider, trimmed', async () => {
        const fake = new FakeAiProvider();
        setAiProvider(fake);

        const res = await request(app)
            .post(URL)
            .set('Authorization', bearer())
            .send({ title: '  Add CSV export  ', notes: ' Admins only ' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: { description: expect.any(String) } });
        const { description } = res.body.data as { description: string };
        expect(description).toContain('Add CSV export');
        expect(description).toContain('Notes addressed: Admins only');
        expect(description).toBe(description.trim());
        // The provider gets the trimmed input.
        expect(fake.calls).toEqual([{ title: 'Add CSV export', notes: 'Admins only' }]);
    });

    it('passes no notes when they are omitted or blank', async () => {
        const fake = new FakeAiProvider();
        setAiProvider(fake);
        const auth = bearer();

        await request(app).post(URL).set('Authorization', auth).send({ title: 'A' }).expect(200);
        await request(app)
            .post(URL)
            .set('Authorization', auth)
            .send({ title: 'B', notes: '   ' })
            .expect(200);

        expect(fake.calls).toEqual([{ title: 'A' }, { title: 'B' }]);
    });

    it('caps a long answer at the 5000-character task description limit', async () => {
        setAiProvider({ name: 'long', generateTaskDescription: async () => 'x'.repeat(9000) });

        const res = await request(app)
            .post(URL)
            .set('Authorization', bearer())
            .send({ title: 'T' });

        expect(res.status).toBe(200);
        expect(res.body.data.description).toHaveLength(5000);
    });

    it('returns 503 AI_DISABLED when no provider is configured', async () => {
        setAiProvider(null);

        const res = await request(app)
            .post(URL)
            .set('Authorization', bearer())
            .send({ title: 'T' });

        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('AI_DISABLED');
    });

    it('never builds a real provider under test, even without an override', async () => {
        expect(getAiProvider()).toBeNull();

        const res = await request(app)
            .post(URL)
            .set('Authorization', bearer())
            .send({ title: 'T' });

        expect(res.status).toBe(503);
    });

    it('returns 502 AI_UPSTREAM_ERROR without leaking the provider error', async () => {
        const secret = 'upstream exploded: api key sk-test-123 rejected';
        const failing: AiProvider = {
            name: 'failing',
            generateTaskDescription: async () => {
                throw new Error(secret);
            },
        };
        setAiProvider(failing);

        const res = await request(app)
            .post(URL)
            .set('Authorization', bearer())
            .send({ title: 'T' });

        expect(res.status).toBe(502);
        expect(res.body.error.code).toBe('AI_UPSTREAM_ERROR');
        expect(JSON.stringify(res.body)).not.toContain('exploded');
        expect(JSON.stringify(res.body)).not.toContain('sk-test-123');
    });

    it('returns 502 when the provider answers with only whitespace', async () => {
        setAiProvider({ name: 'blank', generateTaskDescription: async () => '  \n ' });

        const res = await request(app)
            .post(URL)
            .set('Authorization', bearer())
            .send({ title: 'T' });

        expect(res.status).toBe(502);
    });

    it.each([
        ['a missing title', {}],
        ['a blank title', { title: '   ' }],
        ['a title over 200 characters', { title: 'x'.repeat(201) }],
        ['notes over 2000 characters', { title: 'T', notes: 'x'.repeat(2001) }],
        ['an unknown field', { title: 'T', projectId: randomUUID() }],
    ])('returns 422 for %s, without calling the provider', async (_label, body) => {
        const fake = new FakeAiProvider();
        setAiProvider(fake);

        const res = await request(app).post(URL).set('Authorization', bearer()).send(body);

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(fake.calls).toHaveLength(0);
    });

    it('returns 401 without a token', async () => {
        setAiProvider(new FakeAiProvider());

        const res = await request(app).post(URL).send({ title: 'T' });

        expect(res.status).toBe(401);
    });
});

describe('per-user rate limit', () => {
    // The route's limiter is skipped under NODE_ENV=test; rebuild it with the same key generator,
    // a limit of 2 and skipping off. Both users come from the same IP, so separate buckets prove
    // the key is the user, not the address.
    function limitedApp() {
        const tiny = express();
        tiny.use(pinoHttp({ logger }));
        tiny.post(
            '/limited',
            authenticate,
            createRateLimiter({
                windowMs: 60_000,
                limit: 2,
                skipInTest: false,
                keyGenerator: byUserId,
            }),
            (_req, res) => {
                res.json({ data: 'ok' });
            },
        );
        tiny.use(errorHandler);
        return tiny;
    }

    it('limits each user separately', async () => {
        const tiny = limitedApp();
        const alice = bearer();
        const bob = bearer();
        const send = (auth: string) => request(tiny).post('/limited').set('Authorization', auth);

        expect((await send(alice)).status).toBe(200);
        expect((await send(alice)).status).toBe(200);
        const third = await send(alice);
        expect(third.status).toBe(429);
        expect(third.body.error.code).toBe('RATE_LIMITED');

        expect((await send(bob)).status).toBe(200);
    });
});
