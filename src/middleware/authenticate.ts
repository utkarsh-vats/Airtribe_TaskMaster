import type { Request, RequestHandler } from 'express';
import { UnauthorizedError } from '../lib/errors';
import { verifyAccessToken } from '../lib/jwt';

const BEARER = /^Bearer (\S+)$/i;

/** Requires `Authorization: Bearer <access token>` and sets `req.user`. No DB lookup. */
export const authenticate: RequestHandler = (req, _res, next) => {
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    if (!token) {
        throw new UnauthorizedError();
    }

    req.user = { id: verifyAccessToken(token).userId };
    next();
};

/** The authenticated user's id, for handlers mounted behind `authenticate`. */
export function currentUserId(req: Request): string {
    if (!req.user) {
        throw new UnauthorizedError();
    }
    return req.user.id;
}
