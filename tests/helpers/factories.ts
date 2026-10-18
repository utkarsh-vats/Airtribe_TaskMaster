import { randomUUID } from 'node:crypto';
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
