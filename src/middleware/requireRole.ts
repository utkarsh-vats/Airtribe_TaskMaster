import type { ProjectRole } from '@prisma/client';
import type { Request, RequestHandler } from 'express';
import { ForbiddenError } from '../lib/errors';
import { hasRole } from '../lib/roles';

/** 403 unless the caller's project role is at least `min`. Mount after `loadMembership`. */
export function requireRole(min: ProjectRole): RequestHandler {
    return (req, _res, next) => {
        if (!hasRole(currentMembership(req).role, min)) {
            throw new ForbiddenError();
        }
        next();
    };
}

/** The caller's membership, for handlers mounted behind `loadMembership`. */
export function currentMembership(req: Request): NonNullable<Request['membership']> {
    if (!req.membership) {
        // A wiring bug, not a client error: the route is missing loadMembership.
        throw new Error('req.membership is not set; mount loadMembership before this handler');
    }
    return req.membership;
}
