import type { NotificationType, Project } from '@prisma/client';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { subscribe } from '../../src/lib/events';
import {
    closeAllStreams,
    openStreamCount,
    setHeartbeatInterval,
} from '../../src/modules/notifications/sse';
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

interface Team {
    project: Project;
    owner: TestUser;
    admin: TestUser;
    member: TestUser;
}

async function team(): Promise<Team> {
    const owner = await createUser({ name: 'Owner' });
    const admin = await createUser({ name: 'Admin' });
    const member = await createUser({ name: 'Member' });
    const project = await createProject(owner, { name: 'Apollo' });
    await addMember(project.id, admin.id, 'ADMIN');
    await addMember(project.id, member.id, 'MEMBER');
    return { project, owner, admin, member };
}

const tasksUrl = (project: Project, taskId?: string) =>
    `/api/v1/projects/${project.id}/tasks${taskId ? `/${taskId}` : ''}`;

/** The notification types a user has, optionally only of one type. */
async function typesFor(userId: string, type?: NotificationType): Promise<NotificationType[]> {
    const rows = await prisma.notification.findMany({
        where: { recipientId: userId, ...(type ? { type } : {}) },
        orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.type);
}

describe('task notifications', () => {
    it('assigning notifies the assignee, not the actor', async () => {
        const { project, owner, member } = await team();

        await request(app)
            .post(tasksUrl(project))
            .set('Authorization', await authHeader(app, owner))
            .send({ title: 'Launch', assigneeId: member.id })
            .expect(201);

        expect(await typesFor(member.id)).toEqual(['TASK_ASSIGNED']);
        expect(await typesFor(owner.id)).toEqual([]);
    });

    it('self-assignment creates nothing', async () => {
        const { project, member } = await team();
        const auth = await authHeader(app, member);

        const created = await request(app)
            .post(tasksUrl(project))
            .set('Authorization', auth)
            .send({ title: 'Mine' })
            .expect(201);
        await request(app)
            .patch(tasksUrl(project, created.body.data.id))
            .set('Authorization', auth)
            .send({ assigneeId: member.id })
            .expect(200);

        expect(await prisma.notification.count()).toBe(0);
    });

    it('completing notifies the creator and assignee, not the actor', async () => {
        const { project, owner, admin, member } = await team();
        const task = await createTask(project.id, owner.id, { assigneeId: member.id });

        await request(app)
            .patch(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, admin))
            .send({ status: 'COMPLETED' })
            .expect(200);

        expect(await typesFor(owner.id)).toEqual(['TASK_COMPLETED']);
        expect(await typesFor(member.id)).toEqual(['TASK_COMPLETED']);
        expect(await typesFor(admin.id)).toEqual([]);
    });

    it('the assignee completing their own task notifies only the creator', async () => {
        const { project, owner, member } = await team();
        const task = await createTask(project.id, owner.id, { assigneeId: member.id });

        await request(app)
            .patch(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, member))
            .send({ status: 'COMPLETED' })
            .expect(200);

        expect(await typesFor(owner.id)).toEqual(['TASK_COMPLETED']);
        expect(await typesFor(member.id)).toEqual([]);
    });

    it('a PATCH that reassigns and renames produces only TASK_ASSIGNED', async () => {
        const { project, owner, admin, member } = await team();
        const task = await createTask(project.id, owner.id, { assigneeId: member.id });

        await request(app)
            .patch(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, owner))
            .send({ assigneeId: admin.id, title: 'Renamed', status: 'COMPLETED' })
            .expect(200);

        expect(await typesFor(admin.id)).toEqual(['TASK_ASSIGNED']);
        expect(await typesFor(member.id)).toEqual([]);
        expect(await typesFor(owner.id)).toEqual([]);
    });

    it('other changes notify creator and assignee with changedFields', async () => {
        const { project, owner, admin, member } = await team();
        const task = await createTask(project.id, owner.id, {
            assigneeId: member.id,
            title: 'Old',
            priority: 'LOW',
        });

        await request(app)
            .patch(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, admin))
            // priority sent unchanged: not a change.
            .send({ title: 'New', priority: 'LOW', status: 'IN_PROGRESS' })
            .expect(200);

        const rows = await prisma.notification.findMany({ where: { type: 'TASK_UPDATED' } });
        expect(rows.map((r) => r.recipientId).sort()).toEqual([owner.id, member.id].sort());
        expect(rows[0]?.payload).toMatchObject({ changedFields: ['title', 'status'] });
    });

    it('a PATCH that changes nothing notifies nobody', async () => {
        const { project, owner, admin, member } = await team();
        const task = await createTask(project.id, owner.id, {
            assigneeId: member.id,
            title: 'Same',
        });

        await request(app)
            .patch(tasksUrl(project, task.id))
            .set('Authorization', await authHeader(app, admin))
            .send({ title: 'Same', assigneeId: member.id })
            .expect(200);

        expect(await prisma.notification.count()).toBe(0);
    });

    it('stores a snapshot payload with actor, project and task names', async () => {
        const { project, owner, member } = await team();

        const created = await request(app)
            .post(tasksUrl(project))
            .set('Authorization', await authHeader(app, owner))
            .send({ title: 'Original title', assigneeId: member.id })
            .expect(201);
        // A later rename doesn't rewrite the stored payload.
        await prisma.task.update({
            where: { id: created.body.data.id },
            data: { title: 'Renamed later' },
        });

        const row = await prisma.notification.findFirstOrThrow({
            where: { recipientId: member.id },
        });
        expect(row).toMatchObject({ projectId: project.id, taskId: created.body.data.id });
        expect(row.payload).toEqual({
            actor: { id: owner.id, name: 'Owner' },
            project: { id: project.id, name: 'Apollo' },
            task: { id: created.body.data.id, title: 'Original title' },
        });
    });
});

describe('comment notifications', () => {
    it('a task comment notifies the creator and assignee with a preview', async () => {
        const { project, owner, admin, member } = await team();
        const task = await createTask(project.id, owner.id, { assigneeId: member.id });
        const body = `${'x'.repeat(150)}`;

        await request(app)
            .post(`/api/v1/projects/${project.id}/comments`)
            .set('Authorization', await authHeader(app, admin))
            .send({ body, taskId: task.id })
            .expect(201);

        expect(await typesFor(owner.id)).toEqual(['COMMENT_ADDED']);
        expect(await typesFor(member.id)).toEqual(['COMMENT_ADDED']);
        expect(await typesFor(admin.id)).toEqual([]);
        const row = await prisma.notification.findFirstOrThrow({
            where: { recipientId: owner.id },
        });
        expect(row.payload).toMatchObject({
            commentPreview: 'x'.repeat(140),
            task: { id: task.id },
        });
    });

    it('a project-level comment creates nothing', async () => {
        const { project, admin } = await team();

        await request(app)
            .post(`/api/v1/projects/${project.id}/comments`)
            .set('Authorization', await authHeader(app, admin))
            .send({ body: 'Hello all' })
            .expect(201);

        expect(await prisma.notification.count()).toBe(0);
    });
});

describe('invitation notifications', () => {
    it('inviting an existing user creates PROJECT_INVITATION with the role', async () => {
        const { project, owner } = await team();
        const invitee = await createUser({ name: 'Invitee' });

        const res = await request(app)
            .post(`/api/v1/projects/${project.id}/invitations`)
            .set('Authorization', await authHeader(app, owner))
            .send({ email: invitee.email, role: 'ADMIN' })
            .expect(201);

        const row = await prisma.notification.findFirstOrThrow({
            where: { recipientId: invitee.id },
        });
        expect(row.type).toBe('PROJECT_INVITATION');
        expect(row.taskId).toBeNull();
        expect(row.payload).toEqual({
            actor: { id: owner.id, name: 'Owner' },
            project: { id: project.id, name: 'Apollo' },
            invitationId: res.body.data.id,
            role: 'ADMIN',
        });
    });

    it('inviting an unknown email creates nothing', async () => {
        const { project, owner } = await team();

        await request(app)
            .post(`/api/v1/projects/${project.id}/invitations`)
            .set('Authorization', await authHeader(app, owner))
            .send({ email: 'nobody-yet@example.com' })
            .expect(201);

        expect(await prisma.notification.count()).toBe(0);
    });
});

describe('/api/v1/notifications', () => {
    /** Three notifications for `member`, oldest first; returns their ids. */
    async function seed() {
        const t = await team();
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const n = await prisma.notification.create({
                data: {
                    recipientId: t.member.id,
                    type: 'TASK_UPDATED',
                    projectId: t.project.id,
                    payload: { n: i },
                    createdAt: new Date(Date.now() - (3 - i) * 60_000),
                },
            });
            ids.push(n.id);
        }
        return { ...t, ids, auth: await authHeader(app, t.member) };
    }

    it('lists mine newest first with unreadCount, and filters by unread', async () => {
        const { owner, ids, auth } = await seed();
        await prisma.notification.update({ where: { id: ids[0] }, data: { readAt: new Date() } });
        // Someone else's: never listed.
        await prisma.notification.create({
            data: { recipientId: owner.id, type: 'TASK_UPDATED', payload: {} },
        });

        const all = await request(app).get('/api/v1/notifications').set('Authorization', auth);
        const unread = await request(app)
            .get('/api/v1/notifications?unread=true')
            .set('Authorization', auth);
        const read = await request(app)
            .get('/api/v1/notifications?unread=false')
            .set('Authorization', auth);

        expect(all.status).toBe(200);
        expect(all.body.data.map((n: { id: string }) => n.id)).toEqual([...ids].reverse());
        expect(all.body.meta).toEqual({
            page: 1,
            limit: 20,
            total: 3,
            totalPages: 1,
            unreadCount: 2,
        });
        expect(unread.body.data.map((n: { id: string }) => n.id)).toEqual([ids[2], ids[1]]);
        expect(unread.body.meta).toMatchObject({ total: 2, unreadCount: 2 });
        expect(read.body.data.map((n: { id: string }) => n.id)).toEqual([ids[0]]);
        expect(all.body.data[0]).toEqual({
            id: ids[2],
            type: 'TASK_UPDATED',
            projectId: expect.any(String),
            taskId: null,
            payload: { n: 2 },
            readAt: null,
            createdAt: expect.any(String),
        });
    });

    it.each([['unread=yes'], ['unread=1'], ['foo=bar']])('returns 422 for ?%s', async (query) => {
        const { auth } = await seed();

        const res = await request(app)
            .get(`/api/v1/notifications?${query}`)
            .set('Authorization', auth);

        expect(res.status).toBe(422);
    });

    it('marks one read, idempotently, keeping the first readAt', async () => {
        const { ids, auth } = await seed();
        const markRead = () =>
            request(app).patch(`/api/v1/notifications/${ids[1]}/read`).set('Authorization', auth);

        expect((await markRead()).status).toBe(204);
        const first = await prisma.notification.findUniqueOrThrow({ where: { id: ids[1] } });
        expect((await markRead()).status).toBe(204);
        const second = await prisma.notification.findUniqueOrThrow({ where: { id: ids[1] } });

        expect(first.readAt).not.toBeNull();
        expect(second.readAt).toEqual(first.readAt);
        expect(await prisma.notification.count({ where: { readAt: null } })).toBe(2);
    });

    it("returns 404 for someone else's notification or a missing one", async () => {
        const { owner, ids } = await seed();
        const ownerAuth = await authHeader(app, owner);

        const theirs = await request(app)
            .patch(`/api/v1/notifications/${ids[0]}/read`)
            .set('Authorization', ownerAuth);
        const missing = await request(app)
            .patch(`/api/v1/notifications/${crypto.randomUUID()}/read`)
            .set('Authorization', ownerAuth);

        expect(theirs.status).toBe(404);
        expect(missing.status).toBe(404);
        expect(await prisma.notification.count({ where: { readAt: null } })).toBe(3);
    });

    it('read-all marks every one of mine read, and only mine', async () => {
        const { owner, auth } = await seed();
        await prisma.notification.create({
            data: { recipientId: owner.id, type: 'TASK_UPDATED', payload: {} },
        });

        await request(app)
            .post('/api/v1/notifications/read-all')
            .set('Authorization', auth)
            .expect(204);

        const list = await request(app).get('/api/v1/notifications').set('Authorization', auth);
        expect(list.body.meta.unreadCount).toBe(0);
        expect(await prisma.notification.count({ where: { readAt: null } })).toBe(1);
    });

    it('requires a token', async () => {
        const res = await request(app).get('/api/v1/notifications');

        expect(res.status).toBe(401);
    });
});

describe('handler failures', () => {
    it("a listener that throws doesn't break the request or other listeners", async () => {
        const { project, owner, member } = await team();
        const unsubscribe = subscribe('task.assigned', () => {
            throw new Error('boom');
        });
        try {
            const res = await request(app)
                .post(tasksUrl(project))
                .set('Authorization', await authHeader(app, owner))
                .send({ title: 'Still works', assigneeId: member.id });

            expect(res.status).toBe(201);
            expect(await typesFor(member.id)).toEqual(['TASK_ASSIGNED']);
        } finally {
            unsubscribe();
        }
    });
});

describe('GET /api/v1/notifications/stream (SSE)', () => {
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
        await new Promise<void>((resolve) => {
            server = app.listen(0, () => resolve());
        });
        port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
        setHeartbeatInterval(25_000);
        closeAllStreams();
        await new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        });
    });

    /** Opens the stream with a bearer token; `text()` returns everything received so far. */
    function openStream(auth: string) {
        let received = '';
        let response: http.IncomingMessage | undefined;
        const req = http.get(
            { port, path: '/api/v1/notifications/stream', headers: { Authorization: auth } },
            (res) => {
                response = res;
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    received += chunk;
                });
            },
        );
        // Destroying the request on purpose surfaces as an error event; ignore it.
        req.on('error', () => undefined);
        return { req, text: () => received, response: () => response };
    }

    async function waitFor(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!check()) {
            if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }

    it('pushes a notification to an open stream and cleans up on disconnect', async () => {
        const { project, owner, member } = await team();
        const stream = openStream(await authHeader(app, member));

        await waitFor(() => stream.text().includes('event: ready'), 'ready event');
        expect(stream.response()?.headers['content-type']).toBe('text/event-stream');
        expect(stream.response()?.headers['cache-control']).toBe('no-cache');
        expect(stream.response()?.headers['x-accel-buffering']).toBe('no');
        expect(openStreamCount(member.id)).toBe(1);

        const created = await request(app)
            .post(tasksUrl(project))
            .set('Authorization', await authHeader(app, owner))
            .send({ title: 'Live', assigneeId: member.id })
            .expect(201);

        await waitFor(() => stream.text().includes('event: notification'), 'notification event');
        const frame = /id: (\S+)\nevent: notification\ndata: (.+)\n\n/.exec(stream.text());
        expect(frame).not.toBeNull();
        const data = JSON.parse(frame?.[2] ?? '{}') as { id: string; type: string; taskId: string };
        expect(data).toMatchObject({ type: 'TASK_ASSIGNED', taskId: created.body.data.id });
        expect(frame?.[1]).toBe(data.id);

        stream.req.destroy();
        await waitFor(() => openStreamCount(member.id) === 0, 'stream cleanup');
    });

    it('sends heartbeat comments', async () => {
        setHeartbeatInterval(50);
        const user = await createUser();
        const stream = openStream(await authHeader(app, user));

        await waitFor(() => stream.text().includes(': ping\n\n'), 'heartbeat');

        stream.req.destroy();
        await waitFor(() => openStreamCount(user.id) === 0, 'stream cleanup');
        setHeartbeatInterval(25_000);
    });

    it('rejects a request without a token', async () => {
        const res = await request(app).get('/api/v1/notifications/stream');

        expect(res.status).toBe(401);
    });
});
