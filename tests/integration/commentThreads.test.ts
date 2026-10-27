import type { Comment, Project } from '@prisma/client';
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
    member: TestUser;
}

async function team(): Promise<Team> {
    const owner = await createUser({ name: 'Owner' });
    const member = await createUser({ name: 'Member' });
    const project = await createProject(owner, { name: 'Apollo' });
    await addMember(project.id, member.id, 'MEMBER');
    return { project, owner, member };
}

const commentsUrl = (project: Project, suffix = '') =>
    `/api/v1/projects/${project.id}/comments${suffix}`;
const repliesUrl = (project: Project, commentId: string, query = '') =>
    commentsUrl(project, `/${commentId}/replies${query ? `?${query}` : ''}`);

type ListedComment = { id: string; body: string; replyCount: number };
const listed = (res: { body: { data: ListedComment[] } }) => res.body.data;
const bodies = (res: { body: { data: ListedComment[] } }) => listed(res).map((c) => c.body);

/** `_count` is Prisma's internal shape; it must never leak into a response. */
function expectNoCount(comments: object[]): void {
    for (const comment of comments) {
        expect(comment).not.toHaveProperty('_count');
    }
}

/** A top-level comment by `owner` with `count` replies by `member`, oldest first. */
async function thread(
    t: Team,
    count: number,
    parentAge = 60,
): Promise<{ parent: Comment; replies: Comment[] }> {
    const parent = await createComment(t.project.id, t.owner.id, {
        body: 'parent',
        createdAt: minutesAgo(parentAge),
    });
    const replies: Comment[] = [];
    for (let i = 1; i <= count; i++) {
        replies.push(
            await createComment(t.project.id, t.member.id, {
                body: `reply-${i}`,
                parentId: parent.id,
                createdAt: minutesAgo(parentAge - i),
            }),
        );
    }
    return { parent, replies };
}

describe('replyCount', () => {
    it('a new top-level comment has replyCount 0 and no _count', async () => {
        const { project, member } = await team();

        const res = await request(app)
            .post(commentsUrl(project))
            .set('Authorization', await authHeader(app, member))
            .send({ body: 'Hello' });

        expect(res.status).toBe(201);
        expect(res.body.data.replyCount).toBe(0);
        expectNoCount([res.body.data]);
    });

    it('a new reply has replyCount 0', async () => {
        const t = await team();
        const { parent } = await thread(t, 0);

        const res = await request(app)
            .post(commentsUrl(t.project))
            .set('Authorization', await authHeader(app, t.member))
            .send({ body: 'A reply', parentId: parent.id });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ parentId: parent.id, replyCount: 0 });
        expectNoCount([res.body.data]);
    });

    it('counts replies in ?parentId=none and in the unfiltered list; replies count 0', async () => {
        const t = await team();
        const { parent, replies } = await thread(t, 2);
        const lonely = await createComment(t.project.id, t.owner.id, {
            body: 'lonely',
            createdAt: minutesAgo(1),
        });
        const auth = await authHeader(app, t.member);

        const topLevel = await request(app)
            .get(commentsUrl(t.project, '?parentId=none'))
            .set('Authorization', auth);
        const all = await request(app).get(commentsUrl(t.project)).set('Authorization', auth);

        expect(topLevel.status).toBe(200);
        expect(listed(topLevel).map((c) => [c.id, c.replyCount])).toEqual([
            [parent.id, 2],
            [lonely.id, 0],
        ]);
        expect(all.status).toBe(200);
        const counts = new Map(listed(all).map((c) => [c.id, c.replyCount]));
        expect(counts.get(parent.id)).toBe(2);
        expect(counts.get(lonely.id)).toBe(0);
        for (const reply of replies) {
            expect(counts.get(reply.id)).toBe(0);
        }
        expectNoCount([...listed(topLevel), ...listed(all)]);
    });

    it('drops to 1 when a reply is deleted; deleting the parent removes its replies', async () => {
        const t = await team();
        const { parent, replies } = await thread(t, 2);
        const memberAuth = await authHeader(app, t.member);
        const ownerAuth = await authHeader(app, t.owner);

        await request(app)
            .delete(commentsUrl(t.project, `/${replies[0]?.id ?? ''}`))
            .set('Authorization', memberAuth)
            .expect(204);
        const afterOne = await request(app)
            .get(commentsUrl(t.project, `/${parent.id}`))
            .set('Authorization', memberAuth);
        expect(afterOne.status).toBe(200);
        expect(afterOne.body.data.replyCount).toBe(1);

        await request(app)
            .delete(commentsUrl(t.project, `/${parent.id}`))
            .set('Authorization', ownerAuth)
            .expect(204);
        const threadList = await request(app)
            .get(commentsUrl(t.project, `?parentId=${parent.id}`))
            .set('Authorization', memberAuth);
        expect(threadList.status).toBe(200);
        expect(threadList.body.data).toEqual([]);
        expect(await prisma.comment.count({ where: { projectId: t.project.id } })).toBe(0);
    });

    it('PATCH on a comment with replies returns the correct replyCount', async () => {
        const t = await team();
        const { parent } = await thread(t, 2);

        const res = await request(app)
            .patch(commentsUrl(t.project, `/${parent.id}`))
            .set('Authorization', await authHeader(app, t.owner))
            .send({ body: 'edited parent' });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ body: 'edited parent', replyCount: 2 });
        expectNoCount([res.body.data]);
    });
});

describe('GET /projects/:projectId/comments/:commentId', () => {
    it('has replyCount, no _count, and still includes task and project summaries', async () => {
        const t = await team();
        const task = await createTask(t.project.id, t.owner.id, { title: 'Ship it' });
        const parent = await createComment(t.project.id, t.owner.id, { taskId: task.id });
        await createComment(t.project.id, t.member.id, { taskId: task.id, parentId: parent.id });

        const res = await request(app)
            .get(commentsUrl(t.project, `/${parent.id}`))
            .set('Authorization', await authHeader(app, t.member));

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            id: parent.id,
            replyCount: 1,
            task: { id: task.id, title: 'Ship it' },
            project: { id: t.project.id, name: 'Apollo' },
        });
        expectNoCount([res.body.data]);
    });
});

describe('GET /projects/:projectId/comments/:commentId/replies', () => {
    it("returns only that comment's replies, oldest first; order=desc reverses", async () => {
        const t = await team();
        const { parent } = await thread(t, 3);
        // Another thread whose replies must not show up.
        await thread(t, 2, 120);
        const auth = await authHeader(app, t.member);

        const asc = await request(app)
            .get(repliesUrl(t.project, parent.id))
            .set('Authorization', auth);
        const desc = await request(app)
            .get(repliesUrl(t.project, parent.id, 'order=desc'))
            .set('Authorization', auth);

        expect(asc.status).toBe(200);
        expect(bodies(asc)).toEqual(['reply-1', 'reply-2', 'reply-3']);
        expect(asc.body.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
        expect(desc.status).toBe(200);
        expect(bodies(desc)).toEqual(['reply-3', 'reply-2', 'reply-1']);
        for (const reply of listed(asc)) {
            expect(reply.replyCount).toBe(0);
        }
        expectNoCount(listed(asc));
    });

    it('paginates with correct meta', async () => {
        const t = await team();
        const { parent } = await thread(t, 3);

        const res = await request(app)
            .get(repliesUrl(t.project, parent.id, 'limit=2&page=2'))
            .set('Authorization', await authHeader(app, t.member));

        expect(res.status).toBe(200);
        expect(bodies(res)).toEqual(['reply-3']);
        expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    });

    it('returns an empty list for a top-level comment with no replies', async () => {
        const t = await team();
        const { parent } = await thread(t, 0);

        const res = await request(app)
            .get(repliesUrl(t.project, parent.id))
            .set('Authorization', await authHeader(app, t.member));

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
        expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
    });

    it("returns 422 VALIDATION_ERROR for a reply's id", async () => {
        const t = await team();
        const { replies } = await thread(t, 1);

        const res = await request(app)
            .get(repliesUrl(t.project, replies[0]?.id ?? ''))
            .set('Authorization', await authHeader(app, t.member));

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details[0].path).toBe('commentId');
    });

    it('returns 404 for a comment that does not exist', async () => {
        const t = await team();

        const res = await request(app)
            .get(repliesUrl(t.project, randomUUID()))
            .set('Authorization', await authHeader(app, t.member));

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it("returns 404 for another project's comment, even when the caller is a member of both", async () => {
        const t = await team();
        const elsewhere = await createProject(t.owner);
        await addMember(elsewhere.id, t.member.id);
        const foreign = await createComment(elsewhere.id, t.owner.id);
        await createComment(elsewhere.id, t.owner.id, { parentId: foreign.id });

        const res = await request(app)
            .get(repliesUrl(t.project, foreign.id))
            .set('Authorization', await authHeader(app, t.member));

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for a non-member', async () => {
        const t = await team();
        const { parent } = await thread(t, 1);

        const res = await request(app)
            .get(repliesUrl(t.project, parent.id))
            .set('Authorization', await authHeader(app, await createUser()));

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Project not found');
    });

    it.each([
        ['taskId', () => `taskId=${randomUUID()}`],
        ['parentId', () => 'parentId=none'],
        ['an arbitrary param', () => 'foo=bar'],
    ])('returns 422 for an unknown query param: %s', async (_label, query) => {
        const t = await team();
        const { parent } = await thread(t, 1);

        const res = await request(app)
            .get(repliesUrl(t.project, parent.id, query()))
            .set('Authorization', await authHeader(app, t.member));

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 422 when commentId is not a uuid', async () => {
        const t = await team();

        const res = await request(app)
            .get(repliesUrl(t.project, 'not-a-uuid'))
            .set('Authorization', await authHeader(app, t.member));

        expect(res.status).toBe(422);
        expect(res.body.error.details[0].path).toBe('commentId');
    });
});
