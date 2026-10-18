import { createHash, randomBytes } from 'node:crypto';

/** Opaque refresh token: 32 random bytes, base64url. Only its hash is stored. */
export function generateRefreshToken(): string {
    return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
