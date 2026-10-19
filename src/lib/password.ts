import { argon2id, hash, verify } from 'argon2';
import { env } from '../config/env';

// Cheap parameters under test only, so suites that create many users stay fast. Production
// uses the library defaults. verify() reads the parameters from the hash, so it needs no switch.
// node-argon2 rejects memoryCost < 1024 and timeCost < 2, so these are its minimums.
const HASH_OPTIONS =
    env.NODE_ENV === 'test'
        ? { type: argon2id, memoryCost: 1024, timeCost: 2, parallelism: 1 }
        : { type: argon2id };

/** Also used for the dummy hash in verifyAgainstDummy, so it gets the same parameters. */
export function hashPassword(password: string): Promise<string> {
    return hash(password, HASH_OPTIONS);
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
