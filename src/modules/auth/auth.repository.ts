import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { publicUserSelect, type PublicUser } from '../users/user.select';

/** The global client or a transaction client, so calls can join a `$transaction`. */
type Db = Prisma.TransactionClient;

export function createUser(data: {
    email: string;
    name: string;
    passwordHash: string;
}): Promise<PublicUser> {
    return prisma.user.create({ data, select: publicUserSelect });
}

export async function emailExists(email: string): Promise<boolean> {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    return user !== null;
}

/** Includes `passwordHash` for login only; the service strips it before returning. */
export function findUserForLogin(email: string) {
    return prisma.user.findUnique({
        where: { email },
        select: { ...publicUserSelect, passwordHash: true },
    });
}

export function createRefreshToken(
    db: Db,
    data: { userId: string; tokenHash: string; userAgent: string | null; expiresAt: Date },
) {
    return db.refreshToken.create({ data, select: { id: true } });
}

export function findRefreshTokenByHash(tokenHash: string) {
    return prisma.refreshToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, expiresAt: true, revokedAt: true },
    });
}

/** Revokes one token only if it is still active. Returns how many rows changed (0 or 1). */
export async function revokeRefreshTokenIfActive(db: Db, id: string): Promise<number> {
    const { count } = await db.refreshToken.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date() },
    });
    return count;
}

export async function revokeRefreshTokenByHash(tokenHash: string): Promise<void> {
    await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
    });
}

export async function revokeAllRefreshTokensForUser(userId: string): Promise<void> {
    await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
    });
}
