import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { publicUserSelect, type PublicUser } from './user.select';

export function findPublicUserById(id: string): Promise<PublicUser | null> {
    return prisma.user.findUnique({ where: { id }, select: publicUserSelect });
}

export function findPasswordHashById(id: string): Promise<{ passwordHash: string } | null> {
    return prisma.user.findUnique({ where: { id }, select: { passwordHash: true } });
}

export function updateProfile(
    id: string,
    data: { name?: string; bio?: string | null; avatarUrl?: string | null },
): Promise<PublicUser> {
    return prisma.user.update({ where: { id }, data, select: publicUserSelect });
}

export async function updatePasswordHash(
    db: Prisma.TransactionClient,
    id: string,
    passwordHash: string,
): Promise<void> {
    await db.user.update({ where: { id }, data: { passwordHash }, select: { id: true } });
}
