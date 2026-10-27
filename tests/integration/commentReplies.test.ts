import { Prisma, type Project } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { subscribe, type DomainEvents } from '../../src/lib/events';
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
    member: TestUser;
}

async function team(): Promise<Team> {
    const owner = await createUser({ name: 'Owner' });
    const member = await createUser({ name: 'Member' });
    const project = await createProject(owner, { name: 'Apollo' });
    await addMember(project.id, member.id, 'MEMBER');
    return { project, owner, member };
}

const commentsUrl = (project: Project, query = '') =>
    `/api/v1/projects/${project.id}/comments${query ? `?${query}` : ''}`;

const bodies = (res: { body: { data: { body: string }[] } }) => res.body.data.map((c) => c.body);

describe('POST /projects/:projectId/comments (replies)', () => {
    async function reply(project: Project, user: TestUser, payload: object) {
        return request(app)
            .post(commentsUrl(project))
            .set('Authorization', await authHeader(app, user))
            .send(payload);
    }

    it('replies to a project-level comment: parentId set, taskId null', async () => {
        const { project, owner, member } = await team();
        const parent = await createComment(project.id, owner.id);

        const res = await reply(project, member, { body: 'Agreed', parentId: parent.id });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            parentId: parent.id,
            taskId: null,
            body: 'Agreed',
            author: { id: member.id, name: member.name },
        });
    });

    it("a reply to a task comment inherits the parent's taskId", async () => {
        const { project, owner, member } = await team();
        const task = await createTask(project.id, owner.id);
        const parent = await createComment(project.id, owner.id, { taskId: task.id });

        const res = await reply(project, member, { body: 'On it', parentId: parent.id });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ parentId: parent.id, taskId: task.id });
    });

    it("accepts an explicit taskId that matches the parent's", async () => {
        const { project, owner, member } = await team();
        const task = await createTask(project.id, owner.id);
        const parent = await createComment(project.id, owner.id, { taskId: task.id });

        const res = await reply(project, member, {
            body: 'Same task',
            parentId: parent.id,
            taskId: task.id,
        });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ parentId: parent.id, taskId: task.id });
    });

    it("returns 422 for a taskId different from the parent's", async () => {
        const { project, owner, member } = await team();
        const task = await createTask(project.id, owner.id);
        const otherTask = await createTask(project.id, owner.id);
        const taskParent = await createComment(project.id, owner.id, { taskId: task.id });
        const projectParent = await createComment(project.id, owner.id);

        const differentTask = await reply(project, member, {
            body: 'x',
            parentId: taskParent.id,
            taskId: otherTask.id,
        });
        const taskOnProjectLevel = await reply(project, member, {
            body: 'x',
            parentId: projectParent.id,
            taskId: task.id,
        });

        for (const res of [differentTask, taskOnProjectLevel]) {
            expect(res.status).toBe(422);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
            expect(res.body.error.details[0].path).toBe('taskId');
        }
        expect(await prisma.comment.count({ where: { parentId: { not: null } } })).toBe(0);
    });

    it('returns 422 for a reply to a reply (one level only)', async () => {
        const { project, owner, member } = await team();
        const parent = await createComment(project.id, owner.id);
        const firstReply = await createComment(project.id, member.id, { parentId: parent.id });

        const res = await reply(project, owner, { body: 'Too deep', parentId: firstReply.id });

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details[0].path).toBe('parentId');
    });

    it('returns 404 for a parentId that does not exist', async () => {
        const { project, member } = await team();

        const res = await reply(project, member, { body: 'x', parentId: randomUUID() });

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for a parent in another project, even one the user belongs to', async () => {
        const { project, owner, member } = await team();
        const elsewhere = await createProject(owner);
        await addMember(elsewhere.id, member.id);
        const foreignParent = await createComment(elsewhere.id, owner.id);

        const res = await reply(project, member, { body: 'x', parentId: foreignParent.id });

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
        expect(await prisma.comment.count({ where: { projectId: project.id } })).toBe(0);
    });

    it('returns 404 when a non-member replies', async () => {
        const { project, owner } = await team();
        const parent = await createComment(project.id, owner.id);

        const res = await reply(project, await createUser(), { body: 'x', parentId: parent.id });

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Project not found');
    });

    it('treats parentId: null as a normal top-level comment', async () => {
        const { project, member } = await team();

        const res = await reply(project, member, { body: 'Top level', parentId: null });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ parentId: null, taskId: null });
    });

    it.each([
        ['a parentId that is not a uuid', { body: 'x', parentId: 'comment-1' }],
        ['an unknown body field', { body: 'x', replyTo: randomUUID() }],
    ])('returns 422 for %s', async (_label, payload) => {
        const { project, member } = await team();

        const res = await reply(project, member, payload);

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
});

describe('GET /projects/:projectId/comments (replies)', () => {
    /**
     * Two top-level comments, each with replies, plus a task thread; explicit timestamps so the
     * order never depends on insert timing.
     */
    async function seed() {
        const t = await team();
        const task = await createTask(t.project.id, t.owner.id);
        const topA = await createComment(t.project.id, t.owner.id, {
            body: 'top-A',
            createdAt: minutesAgo(60),
        });
        const topB = await createComment(t.project.id, t.owner.id, {
            body: 'top-B',
            createdAt: minutesAgo(50),
        });
        const topTask = await createComment(t.project.id, t.owner.id, {
            body: 'top-task',
            taskId: task.id,
            createdAt: minutesAgo(40),
        });
        for (const [body, age] of [
            ['A-reply-3', 10],
            ['A-reply-1', 30],
            ['A-reply-2', 20],
        ] as const) {
            await createComment(t.project.id, t.member.id, {
                body,
                parentId: topA.id,
                createdAt: minutesAgo(age),
            });
        }
        const bReply = await createComment(t.project.id, t.member.id, {
            body: 'B-reply',
            parentId: topB.id,
            createdAt: minutesAgo(15),
        });
        await createComment(t.project.id, t.member.id, {
            body: 'task-reply',
            taskId: task.id,
            parentId: topTask.id,
            createdAt: minutesAgo(5),
        });
        return { ...t, task, topA, topB, topTask, bReply, auth: await authHeader(app, t.member) };
    }

    it('parentId=none returns top-level comments only, and meta.total counts only those', async () => {
        const { project, auth } = await seed();

        const res = await request(app)
            .get(commentsUrl(project, 'parentId=none'))
            .set('Authorization', auth);

        expect(res.status).toBe(200);
        expect(bodies(res)).toEqual(['top-A', 'top-B', 'top-task']);
        expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
        for (const c of res.body.data as { parentId: string | null }[]) {
            expect(c.parentId).toBeNull();
        }
    });

    it("parentId=<id> returns that comment's replies, oldest first, and paginates", async () => {
        const { project, topA, auth } = await seed();

        const all = await request(app)
            .get(commentsUrl(project, `parentId=${topA.id}`))
            .set('Authorization', auth);
        const page2 = await request(app)
            .get(commentsUrl(project, `parentId=${topA.id}&limit=2&page=2`))
            .set('Authorization', auth);

        expect(all.status).toBe(200);
        expect(bodies(all)).toEqual(['A-reply-1', 'A-reply-2', 'A-reply-3']);
        expect(page2.status).toBe(200);
        expect(bodies(page2)).toEqual(['A-reply-3']);
        expect(page2.body.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    });

    it('parentId=none combines with taskId=<id> and taskId=none', async () => {
        const { project, task, auth } = await seed();

        const taskTop = await request(app)
            .get(commentsUrl(project, `parentId=none&taskId=${task.id}`))
            .set('Authorization', auth);
        const projectTop = await request(app)
            .get(commentsUrl(project, 'parentId=none&taskId=none'))
            .set('Authorization', auth);

        expect(taskTop.status).toBe(200);
        expect(bodies(taskTop)).toEqual(['top-task']);
        expect(projectTop.status).toBe(200);
        expect(bodies(projectTop)).toEqual(['top-A', 'top-B']);
    });

    it("parentId of a reply, or of another project's comment, returns an empty list", async () => {
        const { project, owner, bReply, auth } = await seed();
        const elsewhere = await createProject(owner);
        const foreign = await createComment(elsewhere.id, owner.id);
        await createComment(elsewhere.id, owner.id, { parentId: foreign.id });

        for (const parentId of [bReply.id, foreign.id]) {
            const res = await request(app)
                .get(commentsUrl(project, `parentId=${parentId}`))
                .set('Authorization', auth);

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([]);
            expect(res.body.meta.total).toBe(0);
        }
    });

    it('returns 422 for a parentId that is neither a uuid nor "none"', async () => {
        const { project, auth } = await seed();

        const res = await request(app)
            .get(commentsUrl(project, 'parentId=garbage'))
            .set('Authorization', auth);

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('order=desc with parentId=none lists newest top-level comments first', async () => {
        const { project, auth } = await seed();

        const res = await request(app)
            .get(commentsUrl(project, 'parentId=none&order=desc'))
            .set('Authorization', auth);

        expect(res.status).toBe(200);
        expect(bodies(res)).toEqual(['top-task', 'top-B', 'top-A']);
    });
});

describe('comment.created event', () => {
    it('carries parentId for a reply, and parentId: null for a top-level comment', async () => {
        const { project, owner, member } = await team();
        const events: DomainEvents['comment.created'][] = [];
        const unsubscribe = subscribe('comment.created', (payload) => {
            events.push(payload);
        });
        try {
            const auth = await authHeader(app, member);
            const top = await request(app)
                .post(commentsUrl(project))
                .set('Authorization', auth)
                .send({ body: 'Top level' })
                .expect(201);
            const reply = await request(app)
                .post(commentsUrl(project))
                .set('Authorization', await authHeader(app, owner))
                .send({ body: 'A reply', parentId: top.body.data.id })
                .expect(201);

            expect(events).toEqual([
                {
                    projectId: project.id,
                    taskId: null,
                    commentId: top.body.data.id,
                    actorId: member.id,
                    parentId: null,
                },
                {
                    projectId: project.id,
                    taskId: null,
                    commentId: reply.body.data.id,
                    actorId: owner.id,
                    parentId: top.body.data.id,
                },
            ]);
        } finally {
            unsubscribe();
        }
    });
});

describe('comments table (schema)', () => {
    it('deleting a parent deletes its replies (ON DELETE CASCADE)', async () => {
        const { project, owner, member } = await team();
        const parent = await createComment(project.id, owner.id);
        const replyA = await createComment(project.id, member.id, { parentId: parent.id });
        const replyB = await createComment(project.id, owner.id, { parentId: parent.id });
        const unrelated = await createComment(project.id, member.id);

        await prisma.comment.delete({ where: { id: parent.id } });

        const remaining = await prisma.comment.findMany({ where: { projectId: project.id } });
        expect(remaining.map((c) => c.id)).toEqual([unrelated.id]);
        expect(remaining.map((c) => c.id)).not.toContain(replyA.id);
        expect(remaining.map((c) => c.id)).not.toContain(replyB.id);
    });

    it('rejects a reply whose parent is in another project (composite FK, P2003)', async () => {
        const { project, owner } = await team();
        const elsewhere = await createProject(owner);
        const foreignParent = await createComment(elsewhere.id, owner.id);

        const attempt = createComment(project.id, owner.id, { parentId: foreignParent.id });

        await expect(attempt).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        await expect(attempt).rejects.toMatchObject({ code: 'P2003' });
        expect(await prisma.comment.count({ where: { projectId: project.id } })).toBe(0);
    });

    it('inserts top-level comments (parentId NULL skips the FK)', async () => {
        const { project, owner } = await team();

        const comment = await createComment(project.id, owner.id, { parentId: null });

        expect(comment.parentId).toBeNull();
        expect(await prisma.comment.count({ where: { id: comment.id } })).toBe(1);
    });
});
