import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { resetDb } from '../helpers/db';
import { createUser, loginAs, type TestUser } from '../helpers/factories';

const app = createApp();

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await prisma.$disconnect();
});

/** A fresh user and an access token for them. */
async function signedInUser(): Promise<{ user: TestUser; auth: string; refreshToken: string }> {
    const user = await createUser();
    const tokens = await loginAs(app, user);
    return { user, auth: `Bearer ${tokens.accessToken}`, refreshToken: tokens.refreshToken };
}

describe('GET /api/v1/users/me', () => {
    it('returns the public profile without the password hash', async () => {
        const { user, auth } = await signedInUser();

        const res = await request(app).get('/api/v1/users/me').set('Authorization', auth);

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            id: user.id,
            email: user.email,
            name: user.name,
            bio: null,
            avatarUrl: null,
            createdAt: user.createdAt.toISOString(),
            updatedAt: user.updatedAt.toISOString(),
        });
        expect(res.body.data).not.toHaveProperty('passwordHash');
    });

    it('returns 401 without a token', async () => {
        const res = await request(app).get('/api/v1/users/me');

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when the user no longer exists', async () => {
        const { user, auth } = await signedInUser();
        await prisma.user.delete({ where: { id: user.id } });

        const res = await request(app).get('/api/v1/users/me').set('Authorization', auth);

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
});

describe('PATCH /api/v1/users/me', () => {
    const patchMe = (auth: string, body: object) =>
        request(app).patch('/api/v1/users/me').set('Authorization', auth).send(body);

    it('updates name, bio and avatarUrl', async () => {
        const { user, auth } = await signedInUser();

        const res = await patchMe(auth, {
            name: 'Grace Hopper',
            bio: 'Compilers.',
            avatarUrl: 'https://example.com/grace.png',
        });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            id: user.id,
            email: user.email,
            name: 'Grace Hopper',
            bio: 'Compilers.',
            avatarUrl: 'https://example.com/grace.png',
        });
        expect(res.body.data).not.toHaveProperty('passwordHash');

        const me = await request(app).get('/api/v1/users/me').set('Authorization', auth);
        expect(me.body.data.name).toBe('Grace Hopper');
    });

    it('trims the name', async () => {
        const { auth } = await signedInUser();

        const res = await patchMe(auth, { name: '  Ada  ' });

        expect(res.status).toBe(200);
        expect(res.body.data.name).toBe('Ada');
    });

    it('clears bio and avatarUrl with null and leaves other fields alone', async () => {
        const { user, auth } = await signedInUser();
        await patchMe(auth, { bio: 'Temporary', avatarUrl: 'http://example.com/a.png' }).expect(
            200,
        );

        const res = await patchMe(auth, { bio: null, avatarUrl: null });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ name: user.name, bio: null, avatarUrl: null });
    });

    it.each([
        ['an empty body', {}],
        ['an unknown field', { name: 'Ok', email: 'new@example.com' }],
        ['an invalid URL', { avatarUrl: 'not a url' }],
        ['a non-http(s) URL', { avatarUrl: 'javascript:alert(1)' }],
        ['a blank name', { name: '   ' }],
        ['a bio over 500 characters', { bio: 'x'.repeat(501) }],
    ])('returns 422 for %s', async (_label, body) => {
        const { auth } = await signedInUser();

        const res = await patchMe(auth, body);

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without a token', async () => {
        const res = await request(app).patch('/api/v1/users/me').send({ name: 'Nope' });

        expect(res.status).toBe(401);
    });
});

describe('PATCH /api/v1/users/me/password', () => {
    const changePassword = (auth: string, body: object) =>
        request(app).patch('/api/v1/users/me/password').set('Authorization', auth).send(body);
    const login = (email: string, password: string) =>
        request(app).post('/api/v1/auth/login').send({ email, password });

    it('changes the password and ends every existing session', async () => {
        const { user, auth, refreshToken } = await signedInUser();
        const newPassword = 'a-brand-new-password';

        const res = await changePassword(auth, { currentPassword: user.password, newPassword });

        expect(res.status).toBe(204);
        expect(res.body).toEqual({});

        expect((await login(user.email, user.password)).status).toBe(401);
        expect((await login(user.email, newPassword)).status).toBe(200);

        const refresh = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
        expect(refresh.status).toBe(401);
        expect(refresh.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('returns 400 INVALID_CURRENT_PASSWORD for a wrong current password', async () => {
        const { user, auth, refreshToken } = await signedInUser();

        const res = await changePassword(auth, {
            currentPassword: 'not-my-password',
            newPassword: 'a-brand-new-password',
        });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');

        // Nothing changed: the old password and session still work.
        expect((await login(user.email, user.password)).status).toBe(200);
        expect(
            (await request(app).post('/api/v1/auth/refresh').send({ refreshToken })).status,
        ).toBe(200);
    });

    it('returns 422 when the new password equals the current one', async () => {
        const { user, auth } = await signedInUser();

        const res = await changePassword(auth, {
            currentPassword: user.password,
            newPassword: user.password,
        });

        expect(res.status).toBe(422);
        expect(res.body.error.details).toEqual([
            { path: 'newPassword', message: expect.any(String) },
        ]);
    });

    it('returns 422 for a new password that is too short', async () => {
        const { user, auth } = await signedInUser();

        const res = await changePassword(auth, {
            currentPassword: user.password,
            newPassword: 'short',
        });

        expect(res.status).toBe(422);
        expect(res.body.error.details[0].path).toBe('newPassword');
    });

    it('returns 401 without a token', async () => {
        const res = await request(app)
            .patch('/api/v1/users/me/password')
            .send({ currentPassword: 'whatever1', newPassword: 'whatever2' });

        expect(res.status).toBe(401);
    });
});
