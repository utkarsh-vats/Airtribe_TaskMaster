import { randomUUID } from 'node:crypto';
import type { InvitationStatus, Project, ProjectInvitation, ProjectRole } from '@prisma/client';
import type { Express } from 'express';
import request from 'supertest';
import { prisma } from '../../src/db/prisma';
import { hashPassword } from '../../src/lib/password';
import type { AuthTokens } from '../../src/modules/auth/auth.service';
import { publicUserSelect, type PublicUser } from '../../src/modules/users/user.select';

export const DEFAULT_PASSWORD = 'correct-horse-battery';

/** A persisted user plus the plain password, so tests can log in as them. */
export type TestUser = PublicUser & { password: string };

export async function createUser(
    overrides: { email?: string; name?: string; password?: string } = {},
): Promise<TestUser> {
    const password = overrides.password ?? DEFAULT_PASSWORD;
    const user = await prisma.user.create({
        data: {
            email: overrides.email ?? `user-${randomUUID()}@example.com`,
            name: overrides.name ?? 'Test User',
            passwordHash: await hashPassword(password),
        },
        select: publicUserSelect,
    });
    return { ...user, password };
}

export async function loginAs(app: Express, user: TestUser): Promise<AuthTokens> {
    const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password });
    if (res.status !== 200) {
        throw new Error(`loginAs failed with ${res.status}: ${JSON.stringify(res.body)}`);
    }
    const { accessToken, refreshToken, expiresIn, tokenType } = res.body.data as AuthTokens;
    return { accessToken, refreshToken, expiresIn, tokenType };
}

/** `Authorization` header value for `user`, via a real login. */
export async function authHeader(app: Express, user: TestUser): Promise<string> {
    return `Bearer ${(await loginAs(app, user)).accessToken}`;
}

/** A project owned by `owner`, with the OWNER membership row, like POST /projects creates. */
export function createProject(
    owner: { id: string },
    overrides: { name?: string; description?: string | null } = {},
): Promise<Project> {
    return prisma.project.create({
        data: {
            name: overrides.name ?? `Project ${randomUUID().slice(0, 8)}`,
            description: overrides.description ?? null,
            createdById: owner.id,
            members: { create: { userId: owner.id, role: 'OWNER' } },
        },
    });
}

export async function addMember(
    projectId: string,
    userId: string,
    role: ProjectRole = 'MEMBER',
): Promise<void> {
    await prisma.projectMember.create({ data: { projectId, userId, role } });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** An invitation row, PENDING and expiring in 7 days unless overridden. */
export function createInvitation(
    projectId: string,
    invitedById: string,
    overrides: {
        email?: string;
        role?: Exclude<ProjectRole, 'OWNER'>;
        status?: InvitationStatus;
        expiresAt?: Date;
    } = {},
): Promise<ProjectInvitation> {
    return prisma.projectInvitation.create({
        data: {
            projectId,
            invitedById,
            email: overrides.email ?? `invitee-${randomUUID()}@example.com`,
            role: overrides.role ?? 'MEMBER',
            status: overrides.status ?? 'PENDING',
            expiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * DAY_MS),
        },
    });
}
