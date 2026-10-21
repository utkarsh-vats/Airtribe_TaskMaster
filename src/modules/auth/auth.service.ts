import { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { ConflictError, UnauthorizedError } from '../../lib/errors';
import { signAccessToken } from '../../lib/jwt';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../../lib/password';
import { generateRefreshToken, hashToken } from '../../lib/tokens';
import type { PublicUser } from '../users/user.select';
import * as authRepository from './auth.repository';
import type { LoginInput, RegisterInput } from './auth.schemas';

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_AGENT_MAX_LENGTH = 255;

export interface AuthTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    tokenType: 'Bearer';
}

const invalidCredentials = () =>
    new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');

const invalidRefreshToken = () =>
    new UnauthorizedError('Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');

/** Stores a new refresh token (hash only) and signs an access token for the user. */
async function issueTokens(
    db: Prisma.TransactionClient,
    userId: string,
    userAgent: string | undefined,
): Promise<AuthTokens> {
    const refreshToken = generateRefreshToken();
    await authRepository.createRefreshToken(db, {
        userId,
        tokenHash: hashToken(refreshToken),
        userAgent: userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS),
    });

    const { token, expiresIn } = signAccessToken(userId);
    return { accessToken: token, refreshToken, expiresIn, tokenType: 'Bearer' };
}

const emailTaken = () => new ConflictError('Email is already registered');

export async function register({ email, password, name }: RegisterInput): Promise<PublicUser> {
    if (await authRepository.emailExists(email)) {
        throw emailTaken();
    }

    const passwordHash = await hashPassword(password);
    try {
        return await authRepository.createUser({ email, name, passwordHash });
    } catch (err) {
        // A concurrent sign-up can still win between the check and the insert.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw emailTaken();
        }
        throw err;
    }
}

export async function login(
    { email, password }: LoginInput,
    userAgent: string | undefined,
): Promise<AuthTokens & { user: PublicUser }> {
    const row = await authRepository.findUserForLogin(email);
    if (!row) {
        await verifyAgainstDummy(password);
        throw invalidCredentials();
    }

    const { passwordHash, ...user } = row;
    if (!(await verifyPassword(passwordHash, password))) {
        throw invalidCredentials();
    }

    const tokens = await issueTokens(prisma, user.id, userAgent);
    return { ...tokens, user };
}

export async function refresh(
    presentedToken: string,
    userAgent: string | undefined,
): Promise<AuthTokens> {
    const row = await authRepository.findRefreshTokenByHash(hashToken(presentedToken));
    if (!row || row.expiresAt <= new Date()) {
        throw invalidRefreshToken();
    }

    if (row.revokedAt) {
        // Reuse of a rotated token means it may have been stolen: end every session. This runs
        // outside any transaction so the revocation is committed before the 401 goes out.
        await authRepository.revokeAllRefreshTokensForUser(row.userId);
        throw invalidRefreshToken();
    }

    return prisma.$transaction(async (tx) => {
        // Guard on `revokedAt: null` so only one of two concurrent refreshes can rotate.
        const revoked = await authRepository.revokeRefreshTokenIfActive(tx, row.id);
        if (revoked !== 1) {
            throw invalidRefreshToken();
        }
        return issueTokens(tx, row.userId, userAgent);
    });
}

/** Idempotent: unknown or already-revoked tokens are ignored. */
export async function logout(presentedToken: string): Promise<void> {
    await authRepository.revokeRefreshTokenByHash(hashToken(presentedToken));
}

export async function logoutAll(userId: string): Promise<void> {
    await authRepository.revokeAllRefreshTokensForUser(userId);
}
