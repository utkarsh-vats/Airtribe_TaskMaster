import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { resetDb } from '../helpers/db';
import { addMember, createProject, createUser, loginAs, type TestUser } from '../helpers/factories';

const app = createApp();

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await prisma.$disconnect();
});

/** A fresh user and their Authorization header value. */
async function signedInUser(): Promise<{ user: TestUser; auth: string }> {
    const user = await createUser();
    const { accessToken } = await loginAs(app, user);
    return { user, auth: `Bearer ${accessToken}` };
}

describe('POST /api/v1/projects', () => {
    it('creates the project with the caller as OWNER', async () => {
        const { user, auth } = await signedInUser();

        const res = await request(app)
            .post('/api/v1/projects')
            .set('Authorization', auth)
            .send({ name: '  Apollo  ', description: 'Moon shot' });

        expect(res.status).toBe(201);
        expect(res.body.data).toEqual({
            id: expect.any(String),
            name: 'Apollo',
            description: 'Moon shot',
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
            myRole: 'OWNER',
            memberCount: 1,
            owner: { id: user.id, name: user.name, email: user.email },
        });

        const members = await prisma.projectMember.findMany({
            where: { projectId: res.body.data.id },
        });
        expect(members).toEqual([expect.objectContaining({ userId: user.id, role: 'OWNER' })]);
    });

    it('allows omitting the description', async () => {
        const { auth } = await signedInUser();

        const res = await request(app)
            .post('/api/v1/projects')
            .set('Authorization', auth)
            .send({ name: 'No description' });

        expect(res.status).toBe(201);
        expect(res.body.data.description).toBeNull();
    });

    it.each([
        ['a missing name', {}],
        ['a blank name', { name: '   ' }],
        ['a name over 100 characters', { name: 'x'.repeat(101) }],
        ['a description over 5000 characters', { name: 'Ok', description: 'x'.repeat(5001) }],
        ['an unknown field', { name: 'Ok', ownerId: randomUUID() }],
    ])('returns 422 for %s', async (_label, body) => {
        const { auth } = await signedInUser();

        const res = await request(app)
            .post('/api/v1/projects')
            .set('Authorization', auth)
            .send(body);

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
});

describe('GET /api/v1/projects', () => {
    it('lists only my projects with my role and member count', async () => {
        const { user, auth } = await signedInUser();
        const other = await createUser();
        const third = await createUser();

        const mine = await createProject(user, { name: 'Mine' });
        await addMember(mine.id, third.id, 'MEMBER');
        const shared = await createProject(other, { name: 'Shared with me' });
        await addMember(shared.id, user.id, 'ADMIN');
        await createProject(other, { name: 'Not mine' });

        const res = await request(app).get('/api/v1/projects').set('Authorization', auth);

        expect(res.status).toBe(200);
        expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });

        const byName = new Map(
            (res.body.data as { name: string }[]).map((p) => [p.name, p] as const),
        );
        expect([...byName.keys()].sort()).toEqual(['Mine', 'Shared with me']);
        expect(byName.get('Mine')).toMatchObject({ myRole: 'OWNER', memberCount: 2 });
        expect(byName.get('Shared with me')).toMatchObject({ myRole: 'ADMIN', memberCount: 2 });
        expect(byName.get('Mine')).not.toHaveProperty('owner');
    });

    it('orders by most recently updated and paginates', async () => {
        const { user, auth } = await signedInUser();
        // Explicit timestamps (relative to now) so the order doesn't depend on insert timing.
        const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
        for (const [name, age] of [
            ['A', 1],
            ['B', 3],
            ['C', 2],
        ] as const) {
            const project = await createProject(user, { name });
            await prisma.project.update({
                where: { id: project.id },
                data: { updatedAt: minutesAgo(age) },
            });
        }

        const first = await request(app)
            .get('/api/v1/projects?page=1&limit=2')
            .set('Authorization', auth);
        const second = await request(app)
            .get('/api/v1/projects?page=2&limit=2')
            .set('Authorization', auth);

        expect(first.status).toBe(200);
        expect(first.body.data.map((p: { name: string }) => p.name)).toEqual(['A', 'C']);
        expect(first.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
        expect(second.body.data.map((p: { name: string }) => p.name)).toEqual(['B']);
        expect(second.body.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    });

    it('returns 422 for an invalid page size', async () => {
        const { auth } = await signedInUser();

        const res = await request(app)
            .get('/api/v1/projects?limit=1000')
            .set('Authorization', auth);

        expect(res.status).toBe(422);
    });
});

describe('GET /api/v1/projects/:projectId', () => {
    it('returns the project with my role, member count and owner', async () => {
        const owner = await createUser();
        const { user, auth } = await signedInUser();
        const project = await createProject(owner, { name: 'Gemini' });
        await addMember(project.id, user.id, 'MEMBER');

        const res = await request(app)
            .get(`/api/v1/projects/${project.id}`)
            .set('Authorization', auth);

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            id: project.id,
            name: 'Gemini',
            description: null,
            createdAt: project.createdAt.toISOString(),
            updatedAt: project.updatedAt.toISOString(),
            myRole: 'MEMBER',
            memberCount: 2,
            owner: { id: owner.id, name: owner.name, email: owner.email },
        });
    });

    it('returns 404 for a project that does not exist', async () => {
        const { auth } = await signedInUser();

        const res = await request(app)
            .get(`/api/v1/projects/${randomUUID()}`)
            .set('Authorization', auth);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 422 for an invalid UUID', async () => {
        const { auth } = await signedInUser();

        const res = await request(app)
            .get('/api/v1/projects/not-a-uuid')
            .set('Authorization', auth);

        expect(res.status).toBe(422);
        expect(res.body.error.details[0].path).toBe('projectId');
    });
});

describe('non-members', () => {
    it('get 404 (not 403) on GET, PATCH and DELETE', async () => {
        const owner = await createUser();
        const project = await createProject(owner);
        const { auth } = await signedInUser();
        const url = `/api/v1/projects/${project.id}`;

        const responses = await Promise.all([
            request(app).get(url).set('Authorization', auth),
            request(app).patch(url).set('Authorization', auth).send({ name: 'Hijacked' }),
            request(app).delete(url).set('Authorization', auth),
        ]);

        for (const res of responses) {
            expect(res.status).toBe(404);
            expect(res.body.error).toMatchObject({
                code: 'NOT_FOUND',
                message: 'Project not found',
            });
        }
        expect(await prisma.project.count({ where: { id: project.id } })).toBe(1);
    });

    it('get 404 on project sub-routes too', async () => {
        const project = await createProject(await createUser());
        const { auth } = await signedInUser();

        const res = await request(app)
            .get(`/api/v1/projects/${project.id}/members`)
            .set('Authorization', auth);

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Project not found');
    });
});

describe('PATCH /api/v1/projects/:projectId', () => {
    it('returns 403 for a MEMBER', async () => {
        const project = await createProject(await createUser());
        const { user, auth } = await signedInUser();
        await addMember(project.id, user.id, 'MEMBER');

        const res = await request(app)
            .patch(`/api/v1/projects/${project.id}`)
            .set('Authorization', auth)
            .send({ name: 'Renamed' });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('lets an ADMIN update name and clear the description', async () => {
        const project = await createProject(await createUser(), { description: 'Old' });
        const { user, auth } = await signedInUser();
        await addMember(project.id, user.id, 'ADMIN');

        const res = await request(app)
            .patch(`/api/v1/projects/${project.id}`)
            .set('Authorization', auth)
            .send({ name: '  Renamed ', description: null });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            id: project.id,
            name: 'Renamed',
            description: null,
            myRole: 'ADMIN',
            memberCount: 2,
        });
        expect(new Date(res.body.data.updatedAt).getTime()).toBeGreaterThan(
            project.updatedAt.getTime(),
        );
    });

    it.each([
        ['an empty body', {}],
        ['an unknown field', { name: 'Ok', createdById: randomUUID() }],
        ['a blank name', { name: '' }],
    ])('returns 422 for %s', async (_label, body) => {
        const { user, auth } = await signedInUser();
        const project = await createProject(user);

        const res = await request(app)
            .patch(`/api/v1/projects/${project.id}`)
            .set('Authorization', auth)
            .send(body);

        expect(res.status).toBe(422);
    });
});

describe('DELETE /api/v1/projects/:projectId', () => {
    it('returns 403 for an ADMIN', async () => {
        const project = await createProject(await createUser());
        const { user, auth } = await signedInUser();
        await addMember(project.id, user.id, 'ADMIN');

        const res = await request(app)
            .delete(`/api/v1/projects/${project.id}`)
            .set('Authorization', auth);

        expect(res.status).toBe(403);
        expect(await prisma.project.count({ where: { id: project.id } })).toBe(1);
    });

    it('lets the OWNER delete it, cascading to memberships and tasks', async () => {
        const { user, auth } = await signedInUser();
        const project = await createProject(user);
        const member = await createUser();
        await addMember(project.id, member.id, 'MEMBER');
        await prisma.task.create({
            data: { projectId: project.id, title: 'Doomed task', createdById: user.id },
        });

        const res = await request(app)
            .delete(`/api/v1/projects/${project.id}`)
            .set('Authorization', auth);

        expect(res.status).toBe(204);
        expect(await prisma.project.count({ where: { id: project.id } })).toBe(0);
        expect(await prisma.projectMember.count({ where: { projectId: project.id } })).toBe(0);
        expect(await prisma.task.count({ where: { projectId: project.id } })).toBe(0);

        const again = await request(app)
            .get(`/api/v1/projects/${project.id}`)
            .set('Authorization', auth);
        expect(again.status).toBe(404);
    });
});

describe('authentication', () => {
    it.each([
        ['GET', '/api/v1/projects'],
        ['POST', '/api/v1/projects'],
        ['GET', `/api/v1/projects/${randomUUID()}`],
        ['PATCH', `/api/v1/projects/${randomUUID()}`],
        ['DELETE', `/api/v1/projects/${randomUUID()}`],
    ] as const)('%s %s without a token returns 401', async (method, url) => {
        const verb = method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';

        const res = await request(app)[verb](url);

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
});
