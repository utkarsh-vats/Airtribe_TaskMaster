import type { Project } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { resetDb } from '../helpers/db';
import {
    addMember,
    authHeader,
    createProject,
    createTask,
    createUser,
    type TestUser,
} from '../helpers/factories';

const app = createApp();

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await prisma.$disconnect();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY_MS);

interface Team {
    project: Project;
    owner: TestUser;
    admin: TestUser;
    member: TestUser;
    other: TestUser;
}

/** A project with an OWNER, an ADMIN and two MEMBERs. */
async function team(): Promise<Team> {
    const owner = await createUser({ name: 'Owner' });
    const admin = await createUser({ name: 'Admin' });
    const member = await createUser({ name: 'Member' });
    const other = await createUser({ name: 'Other' });
    const project = await createProject(owner, { name: 'Apollo' });
    await addMember(project.id, admin.id, 'ADMIN');
    await addMember(project.id, member.id, 'MEMBER');
    await addMember(project.id, other.id, 'MEMBER');
    return { project, owner, admin, member, other };
}

const tasksUrl = (project: Project, taskId?: string) =>
    `/api/v1/projects/${project.id}/tasks${taskId ? `/${taskId}` : ''}`;

/** GET the task list with `query` as `user`; returns titles in response order. */
async function listTitles(project: Project, user: TestUser, query = ''): Promise<string[]> {
    const res = await request(app)
        .get(`${tasksUrl(project)}${query ? `?${query}` : ''}`)
        .set('Authorization', await authHeader(app, user));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.data as { title: string }[]).map((t) => t.title);
}

describe('POST /projects/:projectId/tasks', () => {
    it('lets a MEMBER create a task with OPEN / MEDIUM defaults', async () => {
        const { project, member } = await team();

        const res = await request(app)
            .post(tasksUrl(project))
            .set('Authorization', await authHeader(app, member))
            .send({ title: '  Write tests  ' });

        expect(res.status).toBe(201);
        expect(res.body.data).toEqual({
            id: expect.any(String),
            projectId: project.id,
            title: 'Write tests',
            description: null,
            status: 'OPEN',
            priority: 'MEDIUM',
            dueDate: null,
            completedAt: null,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
            assignee: null,
            createdBy: { id: member.id, name: member.name, email: member.email },
            commentCount: 0,
            attachmentCount: 0,
        });
    });

    it('accepts all fields and assigns to a member', async () => {
        const { project, owner, member } = await team();
        const due = daysFromNow(3);

        const res = await request(app)
            .post(tasksUrl(project))
            .set('Authorization', await authHeader(app, owner))
            .send({
                title: 'Launch',
                description: 'Go for launch',
                dueDate: due.toISOString(),
                priority: 'URGENT',
                assigneeId: member.id,
            });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            description: 'Go for launch',
            dueDate: due.toISOString(),
            priority: 'URGENT',
            assignee: { id: member.id, name: member.name, email: member.email },
        });
    });

    it('returns 422 on assigneeId when assigning to a non-member', async () => {
        const { project, owner } = await team();
        const outsider = await createUser();

        const res = await request(app)
            .post(tasksUrl(project))
            .set('Authorization', await authHeader(app, owner))
            .send({ title: 'Nope', assigneeId: outsider.id });

        expect(res.status).toBe(422);
        expect(res.body.error.details).toEqual([
            { path: 'assigneeId', message: expect.any(String) },
        ]);
        expect(await prisma.task.count()).toBe(0);
    });

    it.each([
        ['a missing title', {}],
        ['a status (not allowed on create)', { title: 'x', status: 'COMPLETED' }],
        ['a dueDate without an offset', { title: 'x', dueDate: '2030-01-01T10:00:00' }],
        ['an invalid priority', { title: 'x', priority: 'CRITICAL' }],
        ['a title over 200 characters', { title: 'x'.repeat(201) }],
    ])('returns 422 for %s', async (_label, body) => {
        const { project, owner } = await team();

        const res = await request(app)
            .post(tasksUrl(project))
            .set('Authorization', await authHeader(app, owner))
            .send(body);

        expect(res.status).toBe(422);
    });
});

describe('GET /projects/:projectId/tasks/:taskId', () => {
    it('returns the task with people and comment/attachment counts', async () => {
        const { project, owner, member } = await team();
        const task = await createTask(project.id, owner.id, { assigneeId: member.id });
        await prisma.comment.createMany({
            data: [
                { projectId: project.id, taskId: task.id, authorId: owner.id, body: 'one' },
                { projectId: project.id, taskId: task.id, authorId: member.id, body: 'two' },
                // Project-level comment: not counted for the task.
                { projectId: project.id, authorId: owner.id, body: 'project-wide' },
            ],
        });
        await prisma.attachment.create({
            data: {
                projectId: project.id,
                taskId: task.id,
                uploadedById: owner.id,
                originalName: 'spec.pdf',
                storageKey: `test/${randomUUID()}`,
                mimeType: 'application/pdf',
                sizeBytes: 1024,
            },
        });

        const res = await request(app)
            .get(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            id: task.id,
            assignee: { id: member.id, name: member.name, email: member.email },
            createdBy: { id: owner.id, name: owner.name, email: owner.email },
            commentCount: 2,
            attachmentCount: 1,
        });
    });

    it('returns 404 for a non-member', async () => {
        const { project, owner } = await team();
        const task = await createTask(project.id, owner.id);
        const outsider = await createUser();

        const res = await request(app)
            .get(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, outsider));

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Project not found');
    });

    it("returns 404 for another project's task via this project's URL", async () => {
        const { project, owner } = await team();
        const otherProject = await createProject(owner);
        const foreign = await createTask(otherProject.id, owner.id);
        const auth = await authHeader(app, owner);

        for (const req of [
            request(app).get(tasksUrl(project, foreign.id)),
            request(app).patch(tasksUrl(project, foreign.id)).send({ title: 'Hijack' }),
            request(app).delete(tasksUrl(project, foreign.id)),
        ]) {
            const res = await req.set('Authorization', auth);
            expect(res.status).toBe(404);
            expect(res.body.error.message).toBe('Task not found');
        }
        expect(await prisma.task.count({ where: { id: foreign.id } })).toBe(1);
    });

    it('returns 422 for an invalid taskId', async () => {
        const { project, owner } = await team();

        const res = await request(app)
            .get(`${tasksUrl(project)}/not-a-uuid`)
            .set('Authorization', await authHeader(app, owner));

        expect(res.status).toBe(422);
        expect(res.body.error.details[0].path).toBe('taskId');
    });
});

describe('PATCH /projects/:projectId/tasks/:taskId', () => {
    it('sets completedAt on completion and clears it on reopen', async () => {
        const { project, owner } = await team();
        const task = await createTask(project.id, owner.id);
        const auth = await authHeader(app, owner);
        const patch = (body: object) =>
            request(app).patch(tasksUrl(project, task.id)).set('Authorization', auth).send(body);

        const before = Date.now();
        const completed = await patch({ status: 'COMPLETED' });
        expect(completed.status).toBe(200);
        expect(completed.body.data.status).toBe('COMPLETED');
        expect(new Date(completed.body.data.completedAt).getTime()).toBeGreaterThanOrEqual(
            before - 1000,
        );

        const reopened = await patch({ status: 'IN_PROGRESS' });
        expect(reopened.status).toBe(200);
        expect(reopened.body.data).toMatchObject({ status: 'IN_PROGRESS', completedAt: null });
    });

    it('keeps the original completedAt when other fields change on a completed task', async () => {
        const { project, owner } = await team();
        const task = await createTask(project.id, owner.id);
        const auth = await authHeader(app, owner);
        const patch = (body: object) =>
            request(app).patch(tasksUrl(project, task.id)).set('Authorization', auth).send(body);

        const completed = await patch({ status: 'COMPLETED' });
        const completedAt = completed.body.data.completedAt as string;

        const renamed = await patch({ title: 'Renamed', priority: 'LOW' });
        const sameStatus = await patch({ status: 'COMPLETED', description: 'still done' });

        expect(renamed.body.data).toMatchObject({ title: 'Renamed', completedAt });
        expect(sameStatus.status).toBe(200);
        expect(sameStatus.body.data.completedAt).toBe(completedAt);
    });

    it('lets the assignee (not the creator) update and complete it', async () => {
        const { project, owner, member } = await team();
        const task = await createTask(project.id, owner.id, { assigneeId: member.id });

        const res = await request(app)
            .patch(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, member))
            .send({ title: 'Done by assignee', status: 'COMPLETED' });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ title: 'Done by assignee', status: 'COMPLETED' });
    });

    it('returns 403 for a MEMBER who is neither creator nor assignee', async () => {
        const { project, owner, member, other } = await team();
        const task = await createTask(project.id, owner.id, { assigneeId: member.id });

        const res = await request(app)
            .patch(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, other))
            .send({ title: 'Not mine' });

        expect(res.status).toBe(403);
    });

    it('checks permission before the body: 403 wins over 422', async () => {
        const { project, owner, other } = await team();
        const task = await createTask(project.id, owner.id);

        const res = await request(app)
            .patch(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, other))
            .send({ bogus: true });

        expect(res.status).toBe(403);
    });

    it('reassigns to a member, unassigns with null, and rejects non-members on assigneeId', async () => {
        const { project, owner, member } = await team();
        const task = await createTask(project.id, owner.id);
        const auth = await authHeader(app, owner);
        const outsider = await createUser();
        const patch = (body: object) =>
            request(app).patch(tasksUrl(project, task.id)).set('Authorization', auth).send(body);

        const assigned = await patch({ assigneeId: member.id });
        expect(assigned.body.data.assignee).toMatchObject({ id: member.id });

        const unassigned = await patch({ assigneeId: null });
        expect(unassigned.body.data.assignee).toBeNull();

        const rejected = await patch({ assigneeId: outsider.id });
        expect(rejected.status).toBe(422);
        expect(rejected.body.error.details[0].path).toBe('assigneeId');
    });

    it('returns 422 for an empty body or unknown field', async () => {
        const { project, owner } = await team();
        const task = await createTask(project.id, owner.id);
        const auth = await authHeader(app, owner);

        for (const body of [{}, { title: 'ok', completedAt: new Date().toISOString() }]) {
            const res = await request(app)
                .patch(tasksUrl(project, task.id))
                .set('Authorization', auth)
                .send(body);
            expect(res.status).toBe(422);
        }
    });
});

describe('DELETE /projects/:projectId/tasks/:taskId', () => {
    it('lets the creator delete their task', async () => {
        const { project, member } = await team();
        const task = await createTask(project.id, member.id);

        const res = await request(app)
            .delete(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(204);
        expect(await prisma.task.count({ where: { id: task.id } })).toBe(0);
    });

    it('returns 403 for another MEMBER, even the assignee', async () => {
        const { project, member, other } = await team();
        const task = await createTask(project.id, member.id, { assigneeId: other.id });

        const res = await request(app)
            .delete(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, other));

        expect(res.status).toBe(403);
        expect(await prisma.task.count({ where: { id: task.id } })).toBe(1);
    });

    it("lets an ADMIN delete someone else's task", async () => {
        const { project, admin, member } = await team();
        const task = await createTask(project.id, member.id);

        const res = await request(app)
            .delete(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, admin));

        expect(res.status).toBe(204);
    });
});

describe('GET /projects/:projectId/tasks filters', () => {
    it('filters by status (single and comma list) and priority', async () => {
        const { project, owner } = await team();
        await createTask(project.id, owner.id, { title: 'open-low', priority: 'LOW' });
        await createTask(project.id, owner.id, {
            title: 'progress-high',
            status: 'IN_PROGRESS',
            priority: 'HIGH',
        });
        await createTask(project.id, owner.id, {
            title: 'done-urgent',
            status: 'COMPLETED',
            priority: 'URGENT',
        });

        expect(await listTitles(project, owner, 'status=OPEN')).toEqual(['open-low']);
        expect((await listTitles(project, owner, 'status=OPEN,IN_PROGRESS')).sort()).toEqual([
            'open-low',
            'progress-high',
        ]);
        expect((await listTitles(project, owner, 'priority=HIGH,URGENT')).sort()).toEqual([
            'done-urgent',
            'progress-high',
        ]);
    });

    it('filters by assignee (me / unassigned / uuid) and createdBy=me', async () => {
        const { project, owner, member } = await team();
        await createTask(project.id, owner.id, { title: 'mine', assigneeId: member.id });
        await createTask(project.id, owner.id, { title: 'owners', assigneeId: owner.id });
        await createTask(project.id, member.id, { title: 'nobody' });

        expect(await listTitles(project, member, 'assignee=me')).toEqual(['mine']);
        expect(await listTitles(project, member, 'assignee=unassigned')).toEqual(['nobody']);
        expect(await listTitles(project, member, `assignee=${owner.id}`)).toEqual(['owners']);
        expect(await listTitles(project, member, 'createdBy=me')).toEqual(['nobody']);
    });

    it('filters by dueBefore / dueAfter', async () => {
        const { project, owner } = await team();
        await createTask(project.id, owner.id, { title: 'soon', dueDate: daysFromNow(1) });
        await createTask(project.id, owner.id, { title: 'later', dueDate: daysFromNow(10) });
        await createTask(project.id, owner.id, { title: 'undated' });
        const cutoff = encodeURIComponent(daysFromNow(5).toISOString());

        expect(await listTitles(project, owner, `dueBefore=${cutoff}`)).toEqual(['soon']);
        expect(await listTitles(project, owner, `dueAfter=${cutoff}`)).toEqual(['later']);
    });

    it('overdue=true excludes completed and undated tasks; overdue=false is the rest', async () => {
        const { project, owner } = await team();
        await createTask(project.id, owner.id, { title: 'late', dueDate: daysFromNow(-2) });
        await createTask(project.id, owner.id, {
            title: 'late-but-done',
            dueDate: daysFromNow(-2),
            status: 'COMPLETED',
        });
        await createTask(project.id, owner.id, { title: 'future', dueDate: daysFromNow(2) });
        await createTask(project.id, owner.id, { title: 'undated' });

        expect(await listTitles(project, owner, 'overdue=true')).toEqual(['late']);
        expect((await listTitles(project, owner, 'overdue=false')).sort()).toEqual([
            'future',
            'late-but-done',
            'undated',
        ]);
    });

    it('q matches title or description, case-insensitively', async () => {
        const { project, owner } = await team();
        await createTask(project.id, owner.id, { title: 'Fix LOGIN bug' });
        await createTask(project.id, owner.id, {
            title: 'Session work',
            description: 'users get logged out on login',
        });
        await createTask(project.id, owner.id, { title: 'Unrelated' });

        expect((await listTitles(project, owner, 'q=Login')).sort()).toEqual([
            'Fix LOGIN bug',
            'Session work',
        ]);
        expect(await listTitles(project, owner, 'q=nothing-matches')).toEqual([]);
    });
});

describe('GET /projects/:projectId/tasks sorting and pagination', () => {
    it('defaults to createdAt desc', async () => {
        const { project, owner } = await team();
        await createTask(project.id, owner.id, { title: 'old', createdAt: daysFromNow(-3) });
        await createTask(project.id, owner.id, { title: 'new', createdAt: daysFromNow(-1) });
        await createTask(project.id, owner.id, { title: 'mid', createdAt: daysFromNow(-2) });

        expect(await listTitles(project, owner)).toEqual(['new', 'mid', 'old']);
        expect(await listTitles(project, owner, 'order=asc')).toEqual(['old', 'mid', 'new']);
    });

    it('sort=priority defaults to desc (URGENT first)', async () => {
        const { project, owner } = await team();
        for (const priority of ['MEDIUM', 'URGENT', 'LOW', 'HIGH'] as const) {
            await createTask(project.id, owner.id, { title: priority, priority });
        }

        expect(await listTitles(project, owner, 'sort=priority')).toEqual([
            'URGENT',
            'HIGH',
            'MEDIUM',
            'LOW',
        ]);
    });

    it('sort=dueDate puts undated tasks last in both directions', async () => {
        const { project, owner } = await team();
        await createTask(project.id, owner.id, { title: 'undated' });
        await createTask(project.id, owner.id, { title: 'later', dueDate: daysFromNow(5) });
        await createTask(project.id, owner.id, { title: 'sooner', dueDate: daysFromNow(1) });

        expect(await listTitles(project, owner, 'sort=dueDate')).toEqual([
            'sooner',
            'later',
            'undated',
        ]);
        expect(await listTitles(project, owner, 'sort=dueDate&order=desc')).toEqual([
            'later',
            'sooner',
            'undated',
        ]);
    });

    it('sort=title defaults to asc', async () => {
        const { project, owner } = await team();
        for (const title of ['charlie', 'alpha', 'bravo']) {
            await createTask(project.id, owner.id, { title });
        }

        expect(await listTitles(project, owner, 'sort=title')).toEqual([
            'alpha',
            'bravo',
            'charlie',
        ]);
    });

    it('paginates with meta', async () => {
        const { project, owner } = await team();
        for (const title of ['a', 'b', 'c', 'd', 'e']) {
            await createTask(project.id, owner.id, { title });
        }
        const auth = await authHeader(app, owner);

        const res = await request(app)
            .get(`${tasksUrl(project)}?sort=title&page=2&limit=2`)
            .set('Authorization', auth);

        expect(res.status).toBe(200);
        expect(res.body.data.map((t: { title: string }) => t.title)).toEqual(['c', 'd']);
        expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
        expect(res.body.data[0]).toMatchObject({
            assignee: null,
            createdBy: { id: owner.id, name: owner.name },
        });
    });

    it.each([
        ['an invalid status', 'status=DONE'],
        ['one bad value in a status list', 'status=OPEN,DONE'],
        ['an invalid sort field', 'sort=assigneeId'],
        ['an unknown param', 'colour=red'],
        ['overdue=yes', 'overdue=yes'],
        ['a dueBefore that is not ISO 8601', 'dueBefore=tomorrow'],
    ])('returns 422 for %s', async (_label, query) => {
        const { project, owner } = await team();

        const res = await request(app)
            .get(`${tasksUrl(project)}?${query}`)
            .set('Authorization', await authHeader(app, owner));

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
});

describe('GET /users/me/tasks', () => {
    it('lists tasks assigned to me across projects, with project { id, name }', async () => {
        const { project, owner, member } = await team();
        const second = await createProject(owner, { name: 'Gemini' });
        await addMember(second.id, member.id);
        const elsewhere = await createProject(owner, { name: 'Not mine' });

        await createTask(project.id, owner.id, { title: 'apollo-mine', assigneeId: member.id });
        await createTask(second.id, owner.id, { title: 'gemini-mine', assigneeId: member.id });
        await createTask(project.id, owner.id, { title: 'owners', assigneeId: owner.id });
        await createTask(project.id, owner.id, { title: 'unassigned' });
        await createTask(elsewhere.id, owner.id, { title: 'other-project' });

        const res = await request(app)
            .get('/api/v1/users/me/tasks?sort=title')
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(200);
        expect(res.body.data.map((t: { title: string }) => t.title)).toEqual([
            'apollo-mine',
            'gemini-mine',
        ]);
        expect(res.body.data[0].project).toEqual({ id: project.id, name: 'Apollo' });
        expect(res.body.data[1].project).toEqual({ id: second.id, name: 'Gemini' });
        expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    });

    it('applies the shared filters', async () => {
        const { project, owner, member } = await team();
        await createTask(project.id, owner.id, {
            title: 'urgent',
            priority: 'URGENT',
            assigneeId: member.id,
        });
        await createTask(project.id, owner.id, {
            title: 'low',
            priority: 'LOW',
            assigneeId: member.id,
        });

        const res = await request(app)
            .get('/api/v1/users/me/tasks?priority=URGENT')
            .set('Authorization', await authHeader(app, member));

        expect(res.body.data.map((t: { title: string }) => t.title)).toEqual(['urgent']);
    });

    it('rejects the assignee param with 422', async () => {
        const { member } = await team();

        const res = await request(app)
            .get('/api/v1/users/me/tasks?assignee=me')
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(422);
    });
});
