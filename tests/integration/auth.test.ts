import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { prisma } from '../../src/db/prisma';
import { hashToken } from '../../src/lib/tokens';
import { resetDb } from '../helpers/db';
import { createUser, loginAs } from '../helpers/factories';

const app = createApp();

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await prisma.$disconnect();
});

const refresh = (refreshToken: string) =>
    request(app).post('/api/v1/auth/refresh').send({ refreshToken });

describe('POST /api/v1/auth/register', () => {
    it('creates the user and returns it without the password hash', async () => {
        const res = await request(app)
            .post('/api/v1/auth/register')
            .send({ email: 'ada@example.com', password: 'longenough', name: 'Ada' });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ email: 'ada@example.com', name: 'Ada', bio: null });
        expect(res.body.data.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.body.data).not.toHaveProperty('passwordHash');
        expect(res.body.data).not.toHaveProperty('password_hash');
        expect(JSON.stringify(res.body)).not.toContain('argon2');

        const stored = await prisma.user.findUniqueOrThrow({ where: { id: res.body.data.id } });
        expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('normalises the email to trimmed lowercase', async () => {
        const res = await request(app)
            .post('/api/v1/auth/register')
            .send({ email: '  Ada.Lovelace@Example.COM ', password: 'longenough', name: 'Ada' });

        expect(res.status).toBe(201);
        expect(res.body.data.email).toBe('ada.lovelace@example.com');
    });

    it('returns 409 for an email that is already registered, in any case', async () => {
        const existing = await createUser();

        const res = await request(app)
            .post('/api/v1/auth/register')
            .send({ email: existing.email.toUpperCase(), password: 'longenough', name: 'Dup' });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONFLICT');
    });

    it('returns 422 with details for an invalid body', async () => {
        const res = await request(app)
            .post('/api/v1/auth/register')
            .send({ email: 'not-an-email', password: 'short', name: '', extra: true });

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        const paths = (res.body.error.details as { path: string }[]).map((d) => d.path);
        expect(paths).toEqual(expect.arrayContaining(['email', 'password', 'name']));
        expect(res.body.error.details.length).toBeGreaterThanOrEqual(4); // + unknown key
    });
});

describe('POST /api/v1/auth/login', () => {
    it('returns tokens and the public user', async () => {
        const user = await createUser();

        const res = await request(app)
            .post('/api/v1/auth/login')
            .set('User-Agent', 'vitest-agent')
            .send({ email: user.email, password: user.password });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            accessToken: expect.any(String),
            refreshToken: expect.any(String),
            expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
            tokenType: 'Bearer',
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                bio: null,
                avatarUrl: null,
                createdAt: user.createdAt.toISOString(),
                updatedAt: user.updatedAt.toISOString(),
            },
        });

        // Only the hash is stored, with the user agent.
        const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.tokenHash).toBe(hashToken(res.body.data.refreshToken));
        expect(rows[0]?.userAgent).toBe('vitest-agent');
    });

    it('truncates a long user agent to 255 characters', async () => {
        const user = await createUser();

        await request(app)
            .post('/api/v1/auth/login')
            .set('User-Agent', 'x'.repeat(400))
            .send({ email: user.email, password: user.password })
            .expect(200);

        const row = await prisma.refreshToken.findFirstOrThrow({ where: { userId: user.id } });
        expect(row.userAgent).toHaveLength(255);
    });

    it('returns the same 401 for a wrong password and an unknown email', async () => {
        const user = await createUser();

        const wrongPassword = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: user.email, password: 'wrong-password' });
        const unknownEmail = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'nobody@example.com', password: user.password });

        expect(wrongPassword.status).toBe(401);
        expect(unknownEmail.status).toBe(401);
        expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
        expect(unknownEmail.body.error.code).toBe('INVALID_CREDENTIALS');
        expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    });
});

describe('POST /api/v1/auth/refresh', () => {
    it('rotates the refresh token; the old one stops working', async () => {
        const tokens = await loginAs(app, await createUser());

        const first = await refresh(tokens.refreshToken);
        expect(first.status).toBe(200);
        expect(first.body.data).toEqual({
            accessToken: expect.any(String),
            refreshToken: expect.any(String),
            expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
            tokenType: 'Bearer',
        });
        expect(first.body.data.refreshToken).not.toBe(tokens.refreshToken);

        const again = await refresh(tokens.refreshToken);
        expect(again.status).toBe(401);
        expect(again.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('treats reuse of a rotated token as theft and revokes the newer token too', async () => {
        const user = await createUser();
        const tokens = await loginAs(app, user);
        const rotated = await refresh(tokens.refreshToken).expect(200);

        const reuse = await refresh(tokens.refreshToken);
        expect(reuse.status).toBe(401);
        expect(reuse.body.error.code).toBe('INVALID_REFRESH_TOKEN');

        const newer = await refresh(rotated.body.data.refreshToken);
        expect(newer.status).toBe(401);

        const active = await prisma.refreshToken.count({
            where: { userId: user.id, revokedAt: null },
        });
        expect(active).toBe(0);
    });

    it('lets only one of two concurrent refreshes with the same token succeed', async () => {
        const tokens = await loginAs(app, await createUser());

        const results = await Promise.all([
            refresh(tokens.refreshToken),
            refresh(tokens.refreshToken),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it('returns 401 for an unknown token', async () => {
        const res = await refresh('not-a-real-token');

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('returns 401 for an expired token', async () => {
        const user = await createUser();
        const tokens = await loginAs(app, user);
        await prisma.refreshToken.updateMany({
            where: { userId: user.id },
            data: { expiresAt: new Date(Date.now() - 1000) },
        });

        const res = await refresh(tokens.refreshToken);

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });
});

describe('POST /api/v1/auth/logout', () => {
    it('revokes the refresh token so it can no longer refresh', async () => {
        const tokens = await loginAs(app, await createUser());

        await request(app)
            .post('/api/v1/auth/logout')
            .send({ refreshToken: tokens.refreshToken })
            .expect(204);

        const res = await refresh(tokens.refreshToken);
        expect(res.status).toBe(401);
    });

    it('is idempotent for already-revoked and unknown tokens', async () => {
        const tokens = await loginAs(app, await createUser());
        const logout = (refreshToken: string) =>
            request(app).post('/api/v1/auth/logout').send({ refreshToken });

        expect((await logout(tokens.refreshToken)).status).toBe(204);
        expect((await logout(tokens.refreshToken)).status).toBe(204);
        expect((await logout('never-issued')).status).toBe(204);
    });
});

describe('POST /api/v1/auth/logout-all', () => {
    it('requires an access token', async () => {
        const res = await request(app).post('/api/v1/auth/logout-all');

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('revokes every session of the user', async () => {
        const user = await createUser();
        const sessionA = await loginAs(app, user);
        const sessionB = await loginAs(app, user);

        await request(app)
            .post('/api/v1/auth/logout-all')
            .set('Authorization', `Bearer ${sessionA.accessToken}`)
            .expect(204);

        expect((await refresh(sessionA.refreshToken)).status).toBe(401);
        expect((await refresh(sessionB.refreshToken)).status).toBe(401);
    });

    it("leaves other users' sessions alone", async () => {
        const alice = await loginAs(app, await createUser());
        const bob = await loginAs(app, await createUser());

        await request(app)
            .post('/api/v1/auth/logout-all')
            .set('Authorization', `Bearer ${alice.accessToken}`)
            .expect(204);

        expect((await refresh(bob.refreshToken)).status).toBe(200);
    });
});

describe('authenticate middleware', () => {
    it.each([
        ['a non-Bearer scheme', 'Basic dXNlcjpwYXNz'],
        ['a missing token', 'Bearer '],
        ['a garbage token', 'Bearer not.a.jwt'],
    ])('returns 401 UNAUTHORIZED for %s', async (_label, header) => {
        const res = await request(app).post('/api/v1/auth/logout-all').set('Authorization', header);

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects a token signed with another secret', async () => {
        const user = await createUser();
        const forged = sign({}, 'some-other-secret-that-is-at-least-32-chars', {
            algorithm: 'HS256',
            subject: user.id,
            expiresIn: 60,
        });

        const res = await request(app)
            .post('/api/v1/auth/logout-all')
            .set('Authorization', `Bearer ${forged}`);

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 TOKEN_EXPIRED for an expired access token', async () => {
        const user = await createUser();
        const expired = sign({}, env.JWT_ACCESS_SECRET, {
            algorithm: 'HS256',
            subject: user.id,
            expiresIn: -60,
        });

        const res = await request(app)
            .post('/api/v1/auth/logout-all')
            .set('Authorization', `Bearer ${expired}`);

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('TOKEN_EXPIRED');
    });
});
