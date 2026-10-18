import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { InvalidCurrentPasswordError, UnauthorizedError } from '../../lib/errors';
import { hashPassword, verifyPassword } from '../../lib/password';
import * as authRepository from '../auth/auth.repository';
import type { PublicUser } from './user.select';
import type { ChangePasswordInput, UpdateMeInput } from './users.schemas';
import * as usersRepository from './users.repository';

// A valid access token whose user row is gone (tokens outlive users by up to the TTL).
const userGone = () => new UnauthorizedError();

export async function getMe(userId: string): Promise<PublicUser> {
    const user = await usersRepository.findPublicUserById(userId);
    if (!user) {
        throw userGone();
    }
    return user;
}

export async function updateMe(userId: string, input: UpdateMeInput): Promise<PublicUser> {
    try {
        return await usersRepository.updateProfile(userId, input);
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
            throw userGone();
        }
        throw err;
    }
}

/** Verifies the current password, then swaps the hash and ends every session atomically. */
export async function changePassword(
    userId: string,
    { currentPassword, newPassword }: ChangePasswordInput,
): Promise<void> {
    const row = await usersRepository.findPasswordHashById(userId);
    if (!row) {
        throw userGone();
    }
    if (!(await verifyPassword(row.passwordHash, currentPassword))) {
        throw new InvalidCurrentPasswordError();
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction(async (tx) => {
        await usersRepository.updatePasswordHash(tx, userId, passwordHash);
        await authRepository.revokeAllRefreshTokensForUser(userId, tx);
    });
}
