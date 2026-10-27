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
    createComment,
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

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

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
    const project = await createProject(owner);
    await addMember(project.id, admin.id, 'ADMIN');
    await addMember(project.id, member.id, 'MEMBER');
    await addMember(project.id, other.id, 'MEMBER');
    return { project, owner, admin, member, other };
}

const commentsUrl = (project: Project, commentId?: string) =>
    `/api/v1/projects/${project.id}/comments${commentId ? `/${commentId}` : ''}`;

describe('POST /projects/:projectId/comments', () => {
    it('creates a project-level comment with the author, trimming the body', async () => {
        const { project, member } = await team();

        const res = await request(app)
            .post(commentsUrl(project))
            .set('Authorization', await authHeader(app, member))
            .send({ body: '  Looks good  ' });

        expect(res.status).toBe(201);
        // Exactly the comment fields + author { id, name }: no task/project summaries.
        expect(res.body.data).toEqual({
            id: expect.any(String),
            projectId: project.id,
            taskId: null,
            authorId: member.id,
            parentId: null,
            body: 'Looks good',
            editedAt: null,
            createdAt: expect.any(String),
            author: { id: member.id, name: member.name },
        });
    });

    it('creates a task comment when taskId is in this project', async () => {
        const { project, owner, member } = await team();
        const task = await createTask(project.id, owner.id);

        const res = await request(app)
            .post(commentsUrl(project))
            .set('Authorization', await authHeader(app, member))
            .send({ body: 'On it', taskId: task.id });

        expect(res.status).toBe(201);
        expect(res.body.data.taskId).toBe(task.id);
    });

    it('returns 404 for a taskId from another project (or one that does not exist)', async () => {
        const { project, owner } = await team();
        const elsewhere = await createProject(owner);
        const foreignTask = await createTask(elsewhere.id, owner.id);
        const auth = await authHeader(app, owner);

        for (const taskId of [foreignTask.id, randomUUID()]) {
            const res = await request(app)
                .post(commentsUrl(project))
                .set('Authorization', auth)
                .send({ body: 'Sneaky', taskId });

            expect(res.status).toBe(404);
            expect(res.body.error.message).toBe('Task not found');
        }
        expect(await prisma.comment.count()).toBe(0);
    });

    it.each([
        ['a blank body', { body: '   ' }],
        ['a missing body', {}],
        ['a body over 5000 characters', { body: 'x'.repeat(5001) }],
        ['a non-UUID taskId', { body: 'ok', taskId: 'task-1' }],
        ['an unknown field', { body: 'ok', authorId: randomUUID() }],
    ])('returns 422 for %s', async (_label, body) => {
        const { project, member } = await team();

        const res = await request(app)
            .post(commentsUrl(project))
            .set('Authorization', await authHeader(app, member))
            .send(body);

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 for a non-member', async () => {
        const { project } = await team();
        const outsider = await createUser();

        const res = await request(app)
            .post(commentsUrl(project))
            .set('Authorization', await authHeader(app, outsider))
            .send({ body: 'Hello?' });

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Project not found');
    });
});

describe('GET /projects/:projectId/comments', () => {
    /** Two task comments, two project-level comments, by different authors, with set times. */
    async function seed() {
        const t = await team();
        const task = await createTask(t.project.id, t.owner.id);
        const otherTask = await createTask(t.project.id, t.owner.id);
        await createComment(t.project.id, t.owner.id, {
            body: 'project-2',
            createdAt: minutesAgo(2),
        });
        await createComment(t.project.id, t.admin.id, {
            body: 'task-1',
            taskId: task.id,
            createdAt: minutesAgo(4),
        });
        await createComment(t.project.id, t.other.id, {
            body: 'project-1',
            createdAt: minutesAgo(5),
        });
        await createComment(t.project.id, t.owner.id, {
            body: 'task-2',
            taskId: task.id,
            createdAt: minutesAgo(1),
        });
        await createComment(t.project.id, t.owner.id, {
            body: 'other-task',
            taskId: otherTask.id,
            createdAt: minutesAgo(3),
        });
        return { ...t, task };
    }

    const bodies = (res: { body: { data: { body: string }[] } }) =>
        res.body.data.map((c) => c.body);

    it("lists every comment oldest first, including other members' (any member)", async () => {
        const { project, member } = await seed();

        const res = await request(app)
            .get(commentsUrl(project))
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(200);
        expect(bodies(res)).toEqual(['project-1', 'task-1', 'other-task', 'project-2', 'task-2']);
        expect(res.body.data[0].author).toEqual({ id: expect.any(String), name: 'Other' });
        expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 5, totalPages: 1 });
    });

    it("?taskId=<uuid> returns only that task's comments", async () => {
        const { project, member, task } = await seed();

        const res = await request(app)
            .get(`${commentsUrl(project)}?taskId=${task.id}`)
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(200);
        expect(bodies(res)).toEqual(['task-1', 'task-2']);
    });

    it('?taskId=none returns only project-level comments', async () => {
        const { project, member } = await seed();

        const res = await request(app)
            .get(`${commentsUrl(project)}?taskId=none`)
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(200);
        expect(bodies(res)).toEqual(['project-1', 'project-2']);
    });

    it("?taskId= another project's task → 404", async () => {
        const { project, owner } = await seed();
        const elsewhere = await createProject(owner);
        const foreignTask = await createTask(elsewhere.id, owner.id);

        const res = await request(app)
            .get(`${commentsUrl(project)}?taskId=${foreignTask.id}`)
            .set('Authorization', await authHeader(app, owner));

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Task not found');
    });

    it('paginates with meta', async () => {
        const { project, member } = await seed();

        const res = await request(app)
            .get(`${commentsUrl(project)}?page=2&limit=2`)
            .set('Authorization', await authHeader(app, member));

        expect(bodies(res)).toEqual(['other-task', 'project-2']);
        expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
    });

    it('returns 422 for a taskId that is neither a UUID nor "none"', async () => {
        const { project, member } = await team();

        const res = await request(app)
            .get(`${commentsUrl(project)}?taskId=all`)
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(422);
    });

    it('returns 422 for an unknown query param', async () => {
        const { project, member } = await team();

        const res = await request(app)
            .get(`${commentsUrl(project)}?authorId=${member.id}`)
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
});

describe('GET /projects/:projectId/comments/:commentId', () => {
    it('returns the comment with author, task and project summaries to any member', async () => {
        const { project, owner, member } = await team();
        const task = await createTask(project.id, owner.id, {
            title: 'Ship it',
            description: 'Before Friday',
        });
        const comment = await createComment(project.id, owner.id, { taskId: task.id, body: 'Hi' });

        const res = await request(app)
            .get(commentsUrl(project, comment.id))
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            id: comment.id,
            projectId: project.id,
            taskId: task.id,
            authorId: owner.id,
            parentId: null,
            body: 'Hi',
            editedAt: null,
            createdAt: comment.createdAt.toISOString(),
            author: { id: owner.id, name: owner.name },
            task: { id: task.id, title: 'Ship it', description: 'Before Friday' },
            project: { id: project.id, name: project.name },
        });
    });

    it("returns 404 for another project's comment", async () => {
        const { project, owner } = await team();
        const elsewhere = await createProject(owner);
        const foreign = await createComment(elsewhere.id, owner.id);

        const res = await request(app)
            .get(commentsUrl(project, foreign.id))
            .set('Authorization', await authHeader(app, owner));

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Comment not found');
    });
});

describe('PATCH /projects/:projectId/comments/:commentId', () => {
    it('lets the author edit and sets editedAt', async () => {
        const { project, member } = await team();
        const comment = await createComment(project.id, member.id, { body: 'Frist' });
        expect(comment.editedAt).toBeNull();
        const before = Date.now();

        const res = await request(app)
            .patch(commentsUrl(project, comment.id))
            .set('Authorization', await authHeader(app, member))
            .send({ body: '  First  ' });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            id: comment.id,
            projectId: project.id,
            taskId: null,
            authorId: member.id,
            parentId: null,
            body: 'First',
            editedAt: expect.any(String),
            createdAt: comment.createdAt.toISOString(),
            author: { id: member.id, name: member.name },
        });
        expect(new Date(res.body.data.editedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);

        const stored = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
        expect(stored.editedAt).not.toBeNull();
    });

    it("returns 403 when an ADMIN or the OWNER edits someone else's comment", async () => {
        const { project, owner, admin, member } = await team();
        const comment = await createComment(project.id, member.id, { body: 'original' });

        for (const caller of [admin, owner]) {
            const res = await request(app)
                .patch(commentsUrl(project, comment.id))
                .set('Authorization', await authHeader(app, caller))
                .send({ body: 'rewritten' });
            expect(res.status).toBe(403);
        }
        const stored = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
        expect(stored).toMatchObject({ body: 'original', editedAt: null });
    });

    it('checks permission before the body: 403 wins over 422', async () => {
        const { project, member, other } = await team();
        const comment = await createComment(project.id, member.id);

        const res = await request(app)
            .patch(commentsUrl(project, comment.id))
            .set('Authorization', await authHeader(app, other))
            .send({ body: '', extra: true });

        expect(res.status).toBe(403);
    });

    it('checks existence before permission: 404 wins over 403', async () => {
        const { project, owner, other } = await team();
        const elsewhere = await createProject(owner);
        await addMember(elsewhere.id, other.id);
        const foreign = await createComment(elsewhere.id, owner.id);

        const res = await request(app)
            .patch(commentsUrl(project, foreign.id))
            .set('Authorization', await authHeader(app, other))
            .send({ body: 'nope' });

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Comment not found');
    });

    it.each([
        ['a blank body', { body: '  ' }],
        ['an empty body object', {}],
        ['an extra field', { body: 'ok', taskId: randomUUID() }],
    ])('returns 422 to the author for %s', async (_label, body) => {
        const { project, member } = await team();
        const comment = await createComment(project.id, member.id);

        const res = await request(app)
            .patch(commentsUrl(project, comment.id))
            .set('Authorization', await authHeader(app, member))
            .send(body);

        expect(res.status).toBe(422);
    });
});

describe('DELETE /projects/:projectId/comments/:commentId', () => {
    it('lets the author delete their comment', async () => {
        const { project, member } = await team();
        const comment = await createComment(project.id, member.id);

        const res = await request(app)
            .delete(commentsUrl(project, comment.id))
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(204);
        expect(await prisma.comment.count({ where: { id: comment.id } })).toBe(0);
    });

    it("lets an ADMIN delete someone else's comment", async () => {
        const { project, admin, member } = await team();
        const comment = await createComment(project.id, member.id);

        const res = await request(app)
            .delete(commentsUrl(project, comment.id))
            .set('Authorization', await authHeader(app, admin));

        expect(res.status).toBe(204);
    });

    it("returns 403 when a MEMBER deletes someone else's comment", async () => {
        const { project, member, other } = await team();
        const comment = await createComment(project.id, member.id);

        const res = await request(app)
            .delete(commentsUrl(project, comment.id))
            .set('Authorization', await authHeader(app, other));

        expect(res.status).toBe(403);
        expect(await prisma.comment.count({ where: { id: comment.id } })).toBe(1);
    });

    it("returns 404 for another project's comment, even for an ADMIN+", async () => {
        const { project, owner } = await team();
        const elsewhere = await createProject(owner);
        const foreign = await createComment(elsewhere.id, owner.id);

        const res = await request(app)
            .delete(commentsUrl(project, foreign.id))
            .set('Authorization', await authHeader(app, owner));

        expect(res.status).toBe(404);
        expect(await prisma.comment.count({ where: { id: foreign.id } })).toBe(1);
    });

    it('returns 422 for an invalid commentId', async () => {
        const { project, owner } = await team();

        const res = await request(app)
            .delete(`${commentsUrl(project)}/not-a-uuid`)
            .set('Authorization', await authHeader(app, owner));

        expect(res.status).toBe(422);
        expect(res.body.error.details[0].path).toBe('commentId');
    });
});
