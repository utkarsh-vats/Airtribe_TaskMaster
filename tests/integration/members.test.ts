import type { Project, ProjectRole } from '@prisma/client';
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

/** A project with one user per role. */
async function team(): Promise<{
    project: Project;
    owner: TestUser;
    admin: TestUser;
    member: TestUser;
}> {
    const owner = await createUser({ name: 'Owner' });
    const admin = await createUser({ name: 'Admin' });
    const member = await createUser({ name: 'Member' });
    const project = await createProject(owner);
    await addMember(project.id, admin.id, 'ADMIN');
    await addMember(project.id, member.id, 'MEMBER');
    return { project, owner, admin, member };
}

const membersUrl = (project: Project, userId?: string) =>
    `/api/v1/projects/${project.id}/members${userId ? `/${userId}` : ''}`;

async function roleOf(projectId: string, userId: string): Promise<ProjectRole | undefined> {
    const row = await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
    });
    return row?.role;
}

describe('GET /projects/:projectId/members', () => {
    it('lists OWNER, then ADMINs, then MEMBERs, each by join date', async () => {
        const owner = await createUser({ name: 'Owner' });
        const project = await createProject(owner);
        const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

        const joins: [string, ProjectRole, number][] = [
            ['Member new', 'MEMBER', 1],
            ['Admin late', 'ADMIN', 2],
            ['Member old', 'MEMBER', 5],
            ['Admin early', 'ADMIN', 4],
        ];
        for (const [name, role, age] of joins) {
            const user = await createUser({ name });
            await prisma.projectMember.create({
                data: { projectId: project.id, userId: user.id, role, joinedAt: minutesAgo(age) },
            });
        }

        const res = await request(app)
            .get(membersUrl(project))
            .set('Authorization', await authHeader(app, owner));

        expect(res.status).toBe(200);
        expect(res.body.data.map((m: { user: { name: string } }) => m.user.name)).toEqual([
            'Owner',
            'Admin early',
            'Admin late',
            'Member old',
            'Member new',
        ]);
        expect(res.body.data[0]).toEqual({
            user: { id: owner.id, name: 'Owner', email: owner.email, avatarUrl: null },
            role: 'OWNER',
            joinedAt: expect.any(String),
        });
    });

    it('returns 404 for a non-member', async () => {
        const { project } = await team();
        const outsider = await createUser();

        const res = await request(app)
            .get(membersUrl(project))
            .set('Authorization', await authHeader(app, outsider));

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Project not found');
    });
});

describe('PATCH /projects/:projectId/members/:userId', () => {
    it('returns 403 when a MEMBER or ADMIN tries to change roles', async () => {
        const { project, admin, member } = await team();

        for (const caller of [member, admin]) {
            const res = await request(app)
                .patch(membersUrl(project, member.id))
                .set('Authorization', await authHeader(app, caller))
                .send({ role: 'ADMIN' });

            expect(res.status).toBe(403);
        }
        expect(await roleOf(project.id, member.id)).toBe('MEMBER');
    });

    it('lets the OWNER promote a MEMBER to ADMIN and returns the member list', async () => {
        const { project, owner, member } = await team();

        const res = await request(app)
            .patch(membersUrl(project, member.id))
            .set('Authorization', await authHeader(app, owner))
            .send({ role: 'ADMIN' });

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(3);
        expect(
            res.body.data.find((m: { user: { id: string } }) => m.user.id === member.id),
        ).toMatchObject({ role: 'ADMIN' });
        expect(await roleOf(project.id, member.id)).toBe('ADMIN');
    });

    it('transfers ownership: exactly one OWNER, the old owner becomes ADMIN', async () => {
        const { project, owner, member } = await team();

        const res = await request(app)
            .patch(membersUrl(project, member.id))
            .set('Authorization', await authHeader(app, owner))
            .send({ role: 'OWNER' });

        expect(res.status).toBe(200);
        expect(res.body.data[0]).toMatchObject({ role: 'OWNER', user: { id: member.id } });
        expect(await roleOf(project.id, member.id)).toBe('OWNER');
        expect(await roleOf(project.id, owner.id)).toBe('ADMIN');
        expect(
            await prisma.projectMember.count({ where: { projectId: project.id, role: 'OWNER' } }),
        ).toBe(1);

        // The old owner has lost owner rights.
        const retry = await request(app)
            .patch(membersUrl(project, member.id))
            .set('Authorization', await authHeader(app, owner))
            .send({ role: 'MEMBER' });
        expect(retry.status).toBe(403);
    });

    it('returns 409 when the OWNER changes their own role', async () => {
        const { project, owner } = await team();

        const res = await request(app)
            .patch(membersUrl(project, owner.id))
            .set('Authorization', await authHeader(app, owner))
            .send({ role: 'ADMIN' });

        expect(res.status).toBe(409);
        expect(await roleOf(project.id, owner.id)).toBe('OWNER');
    });

    it('returns 404 when the target is not a member', async () => {
        const { project, owner } = await team();
        const outsider = await createUser();

        const res = await request(app)
            .patch(membersUrl(project, outsider.id))
            .set('Authorization', await authHeader(app, owner))
            .send({ role: 'ADMIN' });

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Member not found');
    });

    it('returns 422 for an invalid role or userId', async () => {
        const { project, owner, member } = await team();
        const auth = await authHeader(app, owner);

        const badRole = await request(app)
            .patch(membersUrl(project, member.id))
            .set('Authorization', auth)
            .send({ role: 'SUPERUSER' });
        const badId = await request(app)
            .patch(`/api/v1/projects/${project.id}/members/not-a-uuid`)
            .set('Authorization', auth)
            .send({ role: 'ADMIN' });

        expect(badRole.status).toBe(422);
        expect(badId.status).toBe(422);
        expect(badId.body.error.details[0].path).toBe('userId');
    });
});

describe('DELETE /projects/:projectId/members/:userId', () => {
    it('lets an ADMIN remove a MEMBER but not another ADMIN', async () => {
        const { project, admin, member } = await team();
        const otherAdmin = await createUser();
        await addMember(project.id, otherAdmin.id, 'ADMIN');
        const auth = await authHeader(app, admin);

        const removeMember = await request(app)
            .delete(membersUrl(project, member.id))
            .set('Authorization', auth);
        const removeAdmin = await request(app)
            .delete(membersUrl(project, otherAdmin.id))
            .set('Authorization', auth);

        expect(removeMember.status).toBe(204);
        expect(await roleOf(project.id, member.id)).toBeUndefined();
        expect(removeAdmin.status).toBe(403);
        expect(await roleOf(project.id, otherAdmin.id)).toBe('ADMIN');
    });

    it('lets the OWNER remove an ADMIN', async () => {
        const { project, owner, admin } = await team();

        const res = await request(app)
            .delete(membersUrl(project, admin.id))
            .set('Authorization', await authHeader(app, owner));

        expect(res.status).toBe(204);
        expect(await roleOf(project.id, admin.id)).toBeUndefined();
    });

    it('returns 403 when a MEMBER removes someone else', async () => {
        const { project, member } = await team();
        const otherMember = await createUser();
        await addMember(project.id, otherMember.id);

        const res = await request(app)
            .delete(membersUrl(project, otherMember.id))
            .set('Authorization', await authHeader(app, member));

        expect(res.status).toBe(403);
    });

    it('returns 409 when the OWNER tries to leave', async () => {
        const { project, owner } = await team();

        const res = await request(app)
            .delete(membersUrl(project, owner.id))
            .set('Authorization', await authHeader(app, owner));

        expect(res.status).toBe(409);
        expect(res.body.error.message).toBe('Transfer ownership before leaving');
        expect(await roleOf(project.id, owner.id)).toBe('OWNER');
    });

    it('lets a MEMBER leave', async () => {
        const { project, member } = await team();
        const auth = await authHeader(app, member);

        const res = await request(app)
            .delete(membersUrl(project, member.id))
            .set('Authorization', auth);

        expect(res.status).toBe(204);
        const after = await request(app)
            .get(`/api/v1/projects/${project.id}`)
            .set('Authorization', auth);
        expect(after.status).toBe(404);
    });

    it("unassigns the removed user's open tasks but leaves completed ones assigned", async () => {
        const { project, owner, member } = await team();
        const task = (title: string, status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED') =>
            prisma.task.create({
                data: {
                    projectId: project.id,
                    title,
                    status,
                    completedAt: status === 'COMPLETED' ? new Date() : null,
                    createdById: owner.id,
                    assigneeId: member.id,
                },
            });
        const open = await task('Open', 'OPEN');
        const inProgress = await task('In progress', 'IN_PROGRESS');
        const done = await task('Done', 'COMPLETED');
        // A task in another project must not be touched.
        const elsewhere = await createProject(owner);
        await addMember(elsewhere.id, member.id);
        const other = await prisma.task.create({
            data: {
                projectId: elsewhere.id,
                title: 'Other',
                createdById: owner.id,
                assigneeId: member.id,
            },
        });

        await request(app)
            .delete(membersUrl(project, member.id))
            .set('Authorization', await authHeader(app, owner))
            .expect(204);

        const assignee = async (id: string) =>
            (await prisma.task.findUniqueOrThrow({ where: { id } })).assigneeId;
        expect(await assignee(open.id)).toBeNull();
        expect(await assignee(inProgress.id)).toBeNull();
        expect(await assignee(done.id)).toBe(member.id);
        expect(await assignee(other.id)).toBe(member.id);
    });

    it('returns 404 when the target is not a member', async () => {
        const { project, owner } = await team();

        const res = await request(app)
            .delete(membersUrl(project, randomUUID()))
            .set('Authorization', await authHeader(app, owner));

        expect(res.status).toBe(404);
    });

    it('returns 404 for a non-member caller', async () => {
        const { project, member } = await team();
        const outsider = await createUser();

        const res = await request(app)
            .delete(membersUrl(project, member.id))
            .set('Authorization', await authHeader(app, outsider));

        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe('Project not found');
    });
});
