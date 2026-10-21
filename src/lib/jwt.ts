import { sign, TokenExpiredError, verify, type JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env';
import { UnauthorizedError } from './errors';

const ALGORITHM = 'HS256';

export function signAccessToken(userId: string): { token: string; expiresIn: number } {
    const expiresIn = env.ACCESS_TOKEN_TTL_SECONDS;
    const token = sign({}, env.JWT_ACCESS_SECRET, {
        algorithm: ALGORITHM,
        subject: userId,
        expiresIn,
    });
    return { token, expiresIn };
}

export function verifyAccessToken(token: string): { userId: string } {
    let payload: string | JwtPayload;
    try {
        // Pin the algorithm so a token can't pick its own (e.g. `none`).
        payload = verify(token, env.JWT_ACCESS_SECRET, { algorithms: [ALGORITHM] });
    } catch (err) {
        if (err instanceof TokenExpiredError) {
            throw new UnauthorizedError('Access token expired', 'TOKEN_EXPIRED');
        }
        throw new UnauthorizedError('Invalid access token');
    }

    if (typeof payload === 'string' || typeof payload.sub !== 'string' || payload.sub === '') {
        throw new UnauthorizedError('Invalid access token');
    }
    return { userId: payload.sub };
}
