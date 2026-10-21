import type { Project } from '@prisma/client';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { prisma } from '../../src/db/prisma';
import { logger } from '../../src/lib/logger';
import { storage } from '../../src/lib/storage';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createUploadMiddleware } from '../../src/middleware/upload';
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
const uploadRoot = path.resolve(env.UPLOAD_DIR);

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    await rm(uploadRoot, { recursive: true, force: true });
    await prisma.$disconnect();
});

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

const attachmentsUrl = (project: Project, suffix = '') =>
    `/api/v1/projects/${project.id}/attachments${suffix}`;

/** Upload one file via supertest's multipart support. */
async function upload(
    project: Project,
    user: TestUser,
    {
        content = 'hello world',
        filename = 'notes.txt',
        contentType = 'text/plain',
        taskId,
    }: { content?: string | Buffer; filename?: string; contentType?: string; taskId?: string } = {},
) {
    const req = request(app)
        .post(attachmentsUrl(project))
        .set('Authorization', await authHeader(app, user));
    if (taskId) req.field('taskId', taskId);
    return req.attach('file', Buffer.from(content), { filename, contentType });
}

/** Number of stored files for a project (0 if its directory was never created). */
async function storedFileCount(projectId: string): Promise<number> {
    try {
        return (await readdir(path.join(uploadRoot, projectId))).length;
    } catch {
        return 0;
    }
}

async function storageKeyOf(attachmentId: string): Promise<string> {
    return (await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } })).storageKey;
}

/** Collect the response body as raw bytes, whatever the Content-Type. */
function binary(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
}

describe('POST /projects/:projectId/attachments', () => {
    it('uploads a project-level file and stores it', async () => {
        const { project, member } = await team();

        const res = await upload(project, member, { content: 'hello world' });

        expect(res.status).toBe(201);
        expect(res.body.data).toEqual({
            id: expect.any(String),
            originalName: 'notes.txt',
            mimeType: 'text/plain',
            sizeBytes: 11,
            taskId: null,
            createdAt: expect.any(String),
            uploadedBy: { id: member.id, name: member.name },
        });
        const key = await storageKeyOf(res.body.data.id);
        expect(key).toMatch(new RegExp(`^${project.id}/[0-9a-f-]{36}$`));
        expect(await storage.exists(key)).toBe(true);
    });

    it('uploads a task-level file', async () => {
        const { project, owner, member } = await team();
        const task = await createTask(project.id, owner.id);

        const res = await upload(project, member, {
            filename: 'spec.pdf',
            contentType: 'application/pdf',
            taskId: task.id,
        });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ taskId: task.id, mimeType: 'application/pdf' });
    });

    it('returns 404 for a taskId from another project and writes nothing', async () => {
        const { project, owner } = await team();
        const elsewhere = await createProject(owner);
        const foreignTask = await createTask(elsewhere.id, owner.id);

        const res = await upload(project, owner, { taskId: foreignTask.id });

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Task not found');
        expect(await prisma.attachment.count()).toBe(0);
        expect(await storedFileCount(project.id)).toBe(0);
    });

    it('returns 415 for a MIME type outside the allowlist', async () => {
        const { project, member } = await team();

        const res = await upload(project, member, {
            filename: 'setup.exe',
            contentType: 'application/x-msdownload',
        });

        expect(res.status).toBe(415);
        expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
        expect(await storedFileCount(project.id)).toBe(0);
    });

    it('returns 422 on "file" when no file is sent', async () => {
        const { project, member } = await team();
        const auth = await authHeader(app, member);

        const empty = await request(app).post(attachmentsUrl(project)).set('Authorization', auth);
        const fieldsOnly = await request(app)
            .post(attachmentsUrl(project))
            .set('Authorization', auth)
            .field('taskId', randomUUID());

        for (const res of [empty, fieldsOnly]) {
            expect(res.status).toBe(422);
            expect(res.body.error.details).toEqual([
                { path: 'file', message: 'A file is required' },
            ]);
        }
    });

    it('returns 400 for a second file, or a file under another field name', async () => {
        const { project, member } = await team();
        const auth = await authHeader(app, member);
        const file = Buffer.from('x');
        const opts = { filename: 'a.txt', contentType: 'text/plain' };

        const twoFiles = await request(app)
            .post(attachmentsUrl(project))
            .set('Authorization', auth)
            .attach('file', file, opts)
            .attach('file', file, { ...opts, filename: 'b.txt' });
        const wrongField = await request(app)
            .post(attachmentsUrl(project))
            .set('Authorization', auth)
            .attach('document', file, opts);

        for (const res of [twoFiles, wrongField]) {
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('BAD_REQUEST');
        }
        expect(await prisma.attachment.count()).toBe(0);
    });

    it('returns 422 for an unknown text field or a non-UUID taskId', async () => {
        const { project, member } = await team();
        const auth = await authHeader(app, member);
        const file = { filename: 'a.txt', contentType: 'text/plain' };

        const unknown = await request(app)
            .post(attachmentsUrl(project))
            .set('Authorization', auth)
            .field('note', 'hi')
            .attach('file', Buffer.from('x'), file);
        const badTask = await request(app)
            .post(attachmentsUrl(project))
            .set('Authorization', auth)
            .field('taskId', 'task-1')
            .attach('file', Buffer.from('x'), file);

        expect(unknown.status).toBe(422);
        expect(badTask.status).toBe(422);
    });

    it('stores only the basename of a path-like filename', async () => {
        const { project, member } = await team();
        // Built by hand: supertest/form-data would basename the filename before sending it.
        const boundary = 'testboundary123';
        const body = Buffer.from(
            `--${boundary}\r\n` +
                'Content-Disposition: form-data; name="file"; filename="../../evil.txt"\r\n' +
                'Content-Type: text/plain\r\n\r\n' +
                'gotcha\r\n' +
                `--${boundary}--\r\n`,
        );

        const res = await request(app)
            .post(attachmentsUrl(project))
            .set('Authorization', await authHeader(app, member))
            .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
            .send(body);

        expect(res.status).toBe(201);
        expect(res.body.data.originalName).toBe('evil.txt');
        expect(await storageKeyOf(res.body.data.id)).not.toContain('evil');
    });

    it('returns 404 for a non-member', async () => {
        const { project } = await team();

        const res = await upload(project, await createUser());

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Project not found');
    });
});

describe('upload size limit', () => {
    // The app's limit is env.MAX_UPLOAD_MB (10 MB). Rather than push 10 MB through supertest
    // (the server answers 413 before reading the rest, which can surface as EPIPE/ECONNRESET
    // on the client), build the same middleware with a 1 KB limit behind the real errorHandler.
    function smallLimitApp() {
        const tiny = express();
        tiny.use(pinoHttp({ logger }));
        tiny.post('/upload', createUploadMiddleware({ maxBytes: 1024 }), (req, res) => {
            res.status(201).json({ data: { size: req.file?.size } });
        });
        tiny.use(errorHandler);
        return tiny;
    }

    it('returns 413 PAYLOAD_TOO_LARGE above the limit', async () => {
        const res = await request(smallLimitApp())
            .post('/upload')
            .attach('file', Buffer.alloc(2048, 'a'), {
                filename: 'big.txt',
                contentType: 'text/plain',
            });

        expect(res.status).toBe(413);
        expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('accepts a file at the limit', async () => {
        const res = await request(smallLimitApp())
            .post('/upload')
            .attach('file', Buffer.alloc(1024, 'a'), {
                filename: 'ok.txt',
                contentType: 'text/plain',
            });

        expect(res.status).toBe(201);
        expect(res.body.data.size).toBe(1024);
    });
});

describe('GET /projects/:projectId/attachments', () => {
    it('lists newest first, filters by taskId / none, and paginates', async () => {
        const { project, owner, member } = await team();
        const task = await createTask(project.id, owner.id);
        const ids: Record<string, string> = {};
        for (const [name, taskId] of [
            ['p1', undefined],
            ['t1', task.id],
            ['p2', undefined],
            ['t2', task.id],
        ] as const) {
            const res = await upload(project, member, { filename: `${name}.txt`, taskId });
            ids[name] = res.body.data.id;
        }
        // Explicit timestamps so "newest first" doesn't depend on upload timing.
        const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
        for (const [name, age] of [
            ['p1', 4],
            ['t1', 3],
            ['p2', 2],
            ['t2', 1],
        ] as const) {
            await prisma.attachment.update({
                where: { id: ids[name] },
                data: { createdAt: minutesAgo(age) },
            });
        }
        const auth = await authHeader(app, member);
        const names = (res: { body: { data: { originalName: string }[] } }) =>
            res.body.data.map((a) => a.originalName);

        const all = await request(app).get(attachmentsUrl(project)).set('Authorization', auth);
        const forTask = await request(app)
            .get(attachmentsUrl(project, `?taskId=${task.id}`))
            .set('Authorization', auth);
        const projectLevel = await request(app)
            .get(attachmentsUrl(project, '?taskId=none'))
            .set('Authorization', auth);
        const page2 = await request(app)
            .get(attachmentsUrl(project, '?page=2&limit=3'))
            .set('Authorization', auth);

        expect(names(all)).toEqual(['t2.txt', 'p2.txt', 't1.txt', 'p1.txt']);
        expect(all.body.data[0]).not.toHaveProperty('storageKey');
        expect(names(forTask)).toEqual(['t2.txt', 't1.txt']);
        expect(names(projectLevel)).toEqual(['p2.txt', 'p1.txt']);
        expect(names(page2)).toEqual(['p1.txt']);
        expect(page2.body.meta).toEqual({ page: 2, limit: 3, total: 4, totalPages: 2 });
    });

    it("returns 404 for another project's taskId and 422 for an unknown param", async () => {
        const { project, owner } = await team();
        const elsewhere = await createProject(owner);
        const foreignTask = await createTask(elsewhere.id, owner.id);
        const auth = await authHeader(app, owner);

        const foreign = await request(app)
            .get(attachmentsUrl(project, `?taskId=${foreignTask.id}`))
            .set('Authorization', auth);
        const unknown = await request(app)
            .get(attachmentsUrl(project, '?mimeType=text/plain'))
            .set('Authorization', auth);

        expect(foreign.status).toBe(404);
        expect(unknown.status).toBe(422);
    });
});

describe('GET /projects/:projectId/attachments/:attachmentId', () => {
    it('returns the metadata, and 404 for another project', async () => {
        const { project, owner, member } = await team();
        const uploaded = await upload(project, member);
        const elsewhere = await createProject(owner);
        const auth = await authHeader(app, owner);

        const res = await request(app)
            .get(attachmentsUrl(project, `/${uploaded.body.data.id}`))
            .set('Authorization', auth);
        const wrongProject = await request(app)
            .get(attachmentsUrl(elsewhere, `/${uploaded.body.data.id}`))
            .set('Authorization', auth);

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(uploaded.body.data);
        expect(wrongProject.status).toBe(404);
    });
});

describe('GET /projects/:projectId/attachments/:attachmentId/download', () => {
    it('streams the exact bytes with the stored type and an attachment disposition', async () => {
        const { project, owner, member } = await team();
        const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x80]);
        const uploaded = await upload(project, member, {
            content: bytes,
            filename: 'report.pdf',
            contentType: 'application/pdf',
        });

        const res = await request(app)
            .get(attachmentsUrl(project, `/${uploaded.body.data.id}/download`))
            .set('Authorization', await authHeader(app, owner))
            .buffer(true)
            .parse(binary);

        expect(res.status).toBe(200);
        expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
        expect(res.headers['content-type']).toBe('application/pdf');
        expect(res.headers['content-length']).toBe(String(bytes.length));
        // content-disposition only quotes the name when it has to.
        expect(res.headers['content-disposition']).toBe('attachment; filename=report.pdf');
    });

    it('keeps a non-ASCII filename intact through upload and download', async () => {
        const { project, member } = await team();
        const uploaded = await upload(project, member, {
            filename: 'résumé.pdf',
            contentType: 'application/pdf',
        });

        const res = await request(app)
            .get(attachmentsUrl(project, `/${uploaded.body.data.id}/download`))
            .set('Authorization', await authHeader(app, member))
            .buffer(true)
            .parse(binary);

        expect(uploaded.body.data.originalName).toBe('résumé.pdf');
        expect(res.headers['content-disposition']).toContain(
            "filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
        );
    });

    it('returns 404 when the row exists but the file is gone', async () => {
        const { project, member } = await team();
        const uploaded = await upload(project, member);
        await storage.delete(await storageKeyOf(uploaded.body.data.id));

        const res = await request(app)
            .get(attachmentsUrl(project, `/${uploaded.body.data.id}/download`))
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('File not found');
    });

    it('returns 404 for a non-member', async () => {
        const { project, member } = await team();
        const uploaded = await upload(project, member);

        const res = await request(app)
            .get(attachmentsUrl(project, `/${uploaded.body.data.id}/download`))
            .set('Authorization', await authHeader(app, await createUser()));

        expect(res.status).toBe(404);
    });
});

describe('DELETE /projects/:projectId/attachments/:attachmentId', () => {
    it('lets the uploader delete it and removes the file', async () => {
        const { project, member } = await team();
        const uploaded = await upload(project, member);
        const key = await storageKeyOf(uploaded.body.data.id);

        const res = await request(app)
            .delete(attachmentsUrl(project, `/${uploaded.body.data.id}`))
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(204);
        expect(await prisma.attachment.count()).toBe(0);
        expect(await storage.exists(key)).toBe(false);
    });

    it("lets an ADMIN delete someone else's attachment", async () => {
        const { project, admin, member } = await team();
        const uploaded = await upload(project, member);

        const res = await request(app)
            .delete(attachmentsUrl(project, `/${uploaded.body.data.id}`))
            .set('Authorization', await authHeader(app, admin));

        expect(res.status).toBe(204);
    });

    it('returns 403 when another MEMBER deletes it, and keeps the file', async () => {
        const { project, member, other } = await team();
        const uploaded = await upload(project, member);
        const key = await storageKeyOf(uploaded.body.data.id);

        const res = await request(app)
            .delete(attachmentsUrl(project, `/${uploaded.body.data.id}`))
            .set('Authorization', await authHeader(app, other));

        expect(res.status).toBe(403);
        expect(await storage.exists(key)).toBe(true);
    });

    it('returns 404 for a non-member', async () => {
        const { project, member } = await team();
        const uploaded = await upload(project, member);

        const res = await request(app)
            .delete(attachmentsUrl(project, `/${uploaded.body.data.id}`))
            .set('Authorization', await authHeader(app, await createUser()));

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Project not found');
    });
});

describe('cascading file cleanup', () => {
    it("deleting a task removes its attachments' files but not project-level ones", async () => {
        const { project, owner } = await team();
        const task = await createTask(project.id, owner.id);
        const onTask = await upload(project, owner, { taskId: task.id });
        const onTask2 = await upload(project, owner, { taskId: task.id });
        const projectLevel = await upload(project, owner);
        const keys = await Promise.all(
            [onTask, onTask2, projectLevel].map((r) => storageKeyOf(r.body.data.id)),
        );

        await request(app)
            .delete(`/api/v1/projects/${project.id}/tasks/${task.id}`)
            .set('Authorization', await authHeader(app, owner))
            .expect(204);

        expect(await storage.exists(keys[0] ?? '')).toBe(false);
        expect(await storage.exists(keys[1] ?? '')).toBe(false);
        expect(await storage.exists(keys[2] ?? '')).toBe(true);
        expect(await prisma.attachment.count()).toBe(1);
    });

    it("deleting the project removes all of its attachments' files", async () => {
        const { project, owner } = await team();
        const task = await createTask(project.id, owner.id);
        await upload(project, owner, { taskId: task.id });
        await upload(project, owner);
        expect(await storedFileCount(project.id)).toBe(2);

        await request(app)
            .delete(`/api/v1/projects/${project.id}`)
            .set('Authorization', await authHeader(app, owner))
            .expect(204);

        expect(await storedFileCount(project.id)).toBe(0);
        expect(await prisma.attachment.count()).toBe(0);
    });
});

describe('task attachmentCount', () => {
    it('reflects uploads to the task', async () => {
        const { project, owner } = await team();
        const task = await createTask(project.id, owner.id);
        await upload(project, owner, { taskId: task.id });
        await upload(project, owner, { taskId: task.id });
        await upload(project, owner); // project-level: not counted

        const res = await request(app)
            .get(`/api/v1/projects/${project.id}/tasks/${task.id}`)
            .set('Authorization', await authHeader(app, owner));

        expect(res.body.data.attachmentCount).toBe(2);
    });
});
