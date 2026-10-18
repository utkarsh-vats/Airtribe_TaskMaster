import { argon2id, hash, verify } from 'argon2';

export function hashPassword(password: string): Promise<string> {
    return hash(password, { type: argon2id });
}

/** False for a wrong password and for a malformed stored hash. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    try {
        return await verify(passwordHash, password);
    } catch {
        return false;
    }
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a real argon2 verify against a throwaway hash and always returns false. Login calls it
 * for unknown emails so the response takes as long as a wrong-password attempt.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
    dummyHash ??= hashPassword('dummy-password-for-timing-equalisation');
    await verifyPassword(await dummyHash, password);
    return false;
}
