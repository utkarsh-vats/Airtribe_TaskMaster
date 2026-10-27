import type { Project } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { prisma } from '../../src/db/prisma';
import { resetDb } from '../helpers/db';
import {
    addMember,
    authHeader,
    createInvitation,
    createProject,
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

async function ownedProject(): Promise<{ project: Project; owner: TestUser; auth: string }> {
    const owner = await createUser({ name: 'Owner' });
    const project = await createProject(owner, { name: 'Apollo' });
    return { project, owner, auth: await authHeader(app, owner) };
}

const invitationsUrl = (project: Project) => `/api/v1/projects/${project.id}/invitations`;

describe('POST /projects/:projectId/invitations', () => {
    it('creates a PENDING invitation (MEMBER by default) expiring after the TTL', async () => {
        const { project, owner, auth } = await ownedProject();
        const before = Date.now();

        const res = await request(app)
            .post(invitationsUrl(project))
            .set('Authorization', auth)
            .send({ email: '  New.Person@Example.com ' });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            id: expect.any(String),
            projectId: project.id,
            email: 'new.person@example.com',
            role: 'MEMBER',
            status: 'PENDING',
            respondedAt: null,
            invitedBy: { id: owner.id, name: owner.name },
        });
        const expiresAt = new Date(res.body.data.expiresAt).getTime();
        expect(expiresAt).toBeGreaterThanOrEqual(before + env.INVITATION_TTL_DAYS * DAY_MS);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + env.INVITATION_TTL_DAYS * DAY_MS);
    });

    it('lets the OWNER invite as ADMIN but not an ADMIN', async () => {
        const { project, auth } = await ownedProject();
        const admin = await createUser();
        await addMember(project.id, admin.id, 'ADMIN');

        const byOwner = await request(app)
            .post(invitationsUrl(project))
            .set('Authorization', auth)
            .send({ email: 'a@example.com', role: 'ADMIN' });
        const byAdmin = await request(app)
            .post(invitationsUrl(project))
            .set('Authorization', await authHeader(app, admin))
            .send({ email: 'b@example.com', role: 'ADMIN' });
        const adminInvitesMember = await request(app)
            .post(invitationsUrl(project))
            .set('Authorization', await authHeader(app, admin))
            .send({ email: 'c@example.com', role: 'MEMBER' });

        expect(byOwner.status).toBe(201);
        expect(byAdmin.status).toBe(403);
        expect(adminInvitesMember.status).toBe(201);
    });

    it('returns 403 for a MEMBER and 422 for role OWNER', async () => {
        const { project, auth } = await ownedProject();
        const member = await createUser();
        await addMember(project.id, member.id);

        const byMember = await request(app)
            .post(invitationsUrl(project))
            .set('Authorization', await authHeader(app, member))
            .send({ email: 'x@example.com' });
        const asOwner = await request(app)
            .post(invitationsUrl(project))
            .set('Authorization', auth)
            .send({ email: 'x@example.com', role: 'OWNER' });

        expect(byMember.status).toBe(403);
        expect(asOwner.status).toBe(422);
    });

    it('returns 409 when the email belongs to an existing member', async () => {
        const { project, auth } = await ownedProject();
        const member = await createUser();
        await addMember(project.id, member.id);

        const res = await request(app)
            .post(invitationsUrl(project))
            .set('Authorization', auth)
            .send({ email: member.email.toUpperCase() });

        expect(res.status).toBe(409);
    });

    it('returns 409 for a duplicate pending invitation', async () => {
        const { project, auth } = await ownedProject();
        const invite = () =>
            request(app)
                .post(invitationsUrl(project))
                .set('Authorization', auth)
                .send({ email: 'dup@example.com' });

        expect((await invite()).status).toBe(201);
        const second = await invite();
        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe('CONFLICT');
    });

    it('allows a new invitation once the previous one has expired', async () => {
        const { project, owner, auth } = await ownedProject();
        const stale = await createInvitation(project.id, owner.id, {
            email: 'again@example.com',
            expiresAt: daysFromNow(-1),
        });

        const res = await request(app)
            .post(invitationsUrl(project))
            .set('Authorization', auth)
            .send({ email: 'again@example.com' });

        expect(res.status).toBe(201);
        const old = await prisma.projectInvitation.findUniqueOrThrow({ where: { id: stale.id } });
        expect(old.status).toBe('EXPIRED');
    });
});

describe('GET /projects/:projectId/invitations', () => {
    it('lists newest first, reporting lapsed PENDING rows as EXPIRED', async () => {
        const { project, owner, auth } = await ownedProject();
        const live = await createInvitation(project.id, owner.id, { email: 'live@example.com' });
        const lapsed = await createInvitation(project.id, owner.id, {
            email: 'lapsed@example.com',
            expiresAt: daysFromNow(-1),
        });
        // Explicit createdAt so the order doesn't depend on insert timing.
        await prisma.projectInvitation.update({
            where: { id: live.id },
            data: { createdAt: daysFromNow(-2) },
        });
        await prisma.projectInvitation.update({
            where: { id: lapsed.id },
            data: { createdAt: daysFromNow(-3) },
        });

        const res = await request(app).get(invitationsUrl(project)).set('Authorization', auth);

        expect(res.status).toBe(200);
        expect(
            res.body.data.map((i: { email: string; status: string }) => [i.email, i.status]),
        ).toEqual([
            ['live@example.com', 'PENDING'],
            ['lapsed@example.com', 'EXPIRED'],
        ]);
        expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    });

    it('filters by the effective status', async () => {
        const { project, owner, auth } = await ownedProject();
        await createInvitation(project.id, owner.id, { email: 'live@example.com' });
        await createInvitation(project.id, owner.id, {
            email: 'lapsed@example.com',
            expiresAt: daysFromNow(-1),
        });
        await createInvitation(project.id, owner.id, {
            email: 'marked@example.com',
            status: 'EXPIRED',
            expiresAt: daysFromNow(-5),
        });
        await createInvitation(project.id, owner.id, {
            email: 'gone@example.com',
            status: 'REVOKED',
        });

        const emails = async (status: string) => {
            const res = await request(app)
                .get(`${invitationsUrl(project)}?status=${status}`)
                .set('Authorization', auth);
            expect(res.status).toBe(200);
            return (res.body.data as { email: string }[]).map((i) => i.email).sort();
        };

        expect(await emails('PENDING')).toEqual(['live@example.com']);
        expect(await emails('EXPIRED')).toEqual(['lapsed@example.com', 'marked@example.com']);
        expect(await emails('REVOKED')).toEqual(['gone@example.com']);
    });

    it('returns 422 for an unknown status', async () => {
        const { project, auth } = await ownedProject();

        const res = await request(app)
            .get(`${invitationsUrl(project)}?status=MAYBE`)
            .set('Authorization', auth);

        expect(res.status).toBe(422);
    });
});

describe('DELETE /projects/:projectId/invitations/:invitationId', () => {
    it('revokes a pending invitation, then 409 on a second revoke', async () => {
        const { project, owner, auth } = await ownedProject();
        const invitation = await createInvitation(project.id, owner.id);
        const revoke = () =>
            request(app)
                .delete(`${invitationsUrl(project)}/${invitation.id}`)
                .set('Authorization', auth);

        expect((await revoke()).status).toBe(204);
        const row = await prisma.projectInvitation.findUniqueOrThrow({
            where: { id: invitation.id },
        });
        expect(row.status).toBe('REVOKED');

        expect((await revoke()).status).toBe(409);
    });

    it('returns 409 for an expired invitation', async () => {
        const { project, owner, auth } = await ownedProject();
        const invitation = await createInvitation(project.id, owner.id, {
            expiresAt: daysFromNow(-1),
        });

        const res = await request(app)
            .delete(`${invitationsUrl(project)}/${invitation.id}`)
            .set('Authorization', auth);

        expect(res.status).toBe(409);
    });

    it("returns 404 for another project's invitation", async () => {
        const { project, auth } = await ownedProject();
        const other = await ownedProject();
        const foreign = await createInvitation(other.project.id, other.owner.id);

        const res = await request(app)
            .delete(`${invitationsUrl(project)}/${foreign.id}`)
            .set('Authorization', auth);

        expect(res.status).toBe(404);
        const row = await prisma.projectInvitation.findUniqueOrThrow({ where: { id: foreign.id } });
        expect(row.status).toBe('PENDING');
    });
});

describe('GET /users/me/invitations', () => {
    it('shows only my unexpired pending invitations, with project and inviter', async () => {
        const { project, owner } = await ownedProject();
        const other = await ownedProject();
        const me = await createUser();

        const mine = await createInvitation(project.id, owner.id, {
            email: me.email,
            role: 'ADMIN',
        });
        await createInvitation(other.project.id, other.owner.id, {
            email: me.email,
            expiresAt: daysFromNow(-1),
        });
        await createInvitation(other.project.id, other.owner.id, {
            email: me.email,
            status: 'DECLINED',
        });
        await createInvitation(project.id, owner.id, { email: 'someone-else@example.com' });

        const res = await request(app)
            .get('/api/v1/users/me/invitations')
            .set('Authorization', await authHeader(app, me));

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([
            expect.objectContaining({
                id: mine.id,
                role: 'ADMIN',
                status: 'PENDING',
                project: { id: project.id, name: 'Apollo' },
                invitedBy: { id: owner.id, name: owner.name },
            }),
        ]);
    });
});

describe('POST /invitations/:invitationId/accept', () => {
    it('adds me to the project with the invited role', async () => {
        const { project, owner } = await ownedProject();
        const me = await createUser();
        const invitation = await createInvitation(project.id, owner.id, {
            email: me.email,
            role: 'ADMIN',
        });
        const auth = await authHeader(app, me);

        const res = await request(app)
            .post(`/api/v1/invitations/${invitation.id}/accept`)
            .set('Authorization', auth);

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ projectId: project.id, role: 'ADMIN' });
        const row = await prisma.projectInvitation.findUniqueOrThrow({
            where: { id: invitation.id },
        });
        expect(row.status).toBe('ACCEPTED');
        expect(row.respondedAt).not.toBeNull();

        const projectRes = await request(app)
            .get(`/api/v1/projects/${project.id}`)
            .set('Authorization', auth);
        expect(projectRes.body.data.myRole).toBe('ADMIN');
    });

    it("returns 404 when someone else tries to accept (and doesn't reveal it)", async () => {
        const { project, owner } = await ownedProject();
        const invitee = await createUser();
        const intruder = await createUser();
        const invitation = await createInvitation(project.id, owner.id, { email: invitee.email });

        const res = await request(app)
            .post(`/api/v1/invitations/${invitation.id}/accept`)
            .set('Authorization', await authHeader(app, intruder));
        const missing = await request(app)
            .post(`/api/v1/invitations/${randomUUID()}/accept`)
            .set('Authorization', await authHeader(app, intruder));

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe(missing.body.error.message);
        expect(await prisma.projectMember.count({ where: { userId: intruder.id } })).toBe(0);
    });

    it('returns 409 on a second accept', async () => {
        const { project, owner } = await ownedProject();
        const me = await createUser();
        const invitation = await createInvitation(project.id, owner.id, { email: me.email });
        const auth = await authHeader(app, me);
        const accept = () =>
            request(app)
                .post(`/api/v1/invitations/${invitation.id}/accept`)
                .set('Authorization', auth);

        expect((await accept()).status).toBe(200);
        expect((await accept()).status).toBe(409);
    });

    it('returns 410 INVITATION_EXPIRED for an expired invitation', async () => {
        const { project, owner } = await ownedProject();
        const me = await createUser();
        const invitation = await createInvitation(project.id, owner.id, {
            email: me.email,
            expiresAt: daysFromNow(-1),
        });

        const res = await request(app)
            .post(`/api/v1/invitations/${invitation.id}/accept`)
            .set('Authorization', await authHeader(app, me));

        expect(res.status).toBe(410);
        expect(res.body.error.code).toBe('INVITATION_EXPIRED');
        expect(await prisma.projectMember.count({ where: { userId: me.id } })).toBe(0);
    });

    it('returns 409 when I am already a member', async () => {
        const { project, owner } = await ownedProject();
        const me = await createUser();
        await addMember(project.id, me.id);
        const invitation = await createInvitation(project.id, owner.id, { email: me.email });

        const res = await request(app)
            .post(`/api/v1/invitations/${invitation.id}/accept`)
            .set('Authorization', await authHeader(app, me));

        expect(res.status).toBe(409);
    });
});

describe('POST /invitations/:invitationId/decline', () => {
    it('marks it DECLINED without creating a membership', async () => {
        const { project, owner } = await ownedProject();
        const me = await createUser();
        const invitation = await createInvitation(project.id, owner.id, { email: me.email });
        const auth = await authHeader(app, me);

        const res = await request(app)
            .post(`/api/v1/invitations/${invitation.id}/decline`)
            .set('Authorization', auth);

        expect(res.status).toBe(204);
        const row = await prisma.projectInvitation.findUniqueOrThrow({
            where: { id: invitation.id },
        });
        expect(row.status).toBe('DECLINED');
        expect(row.respondedAt).not.toBeNull();
        expect(await prisma.projectMember.count({ where: { userId: me.id } })).toBe(0);

        const accept = await request(app)
            .post(`/api/v1/invitations/${invitation.id}/accept`)
            .set('Authorization', auth);
        expect(accept.status).toBe(409);
    });
});
