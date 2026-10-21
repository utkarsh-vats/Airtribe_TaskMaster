import type { RequestHandler } from 'express';
import { NotFoundError } from '../lib/errors';
import * as projectsRepository from '../modules/projects/projects.repository';
import { projectIdParamsSchema } from '../modules/projects/projects.schemas';
import { currentUserId } from './authenticate';
import { getValidated } from './validate';

/**
 * Loads the caller's membership of `:projectId` onto `req.membership`. Runs after
 * `authenticate` and `validate({ params: projectIdParamsSchema })`. Non-members get 404, never
 * 403, so a project's existence isn't leaked.
 */
export const loadMembership: RequestHandler = async (req, _res, next) => {
    const { projectId } = getValidated(req, 'params', projectIdParamsSchema);
    const userId = currentUserId(req);

    const membership = await projectsRepository.findMembership(projectId, userId);
    if (!membership) {
        throw new NotFoundError('Project');
    }

    req.membership = { projectId, userId, role: membership.role };
    next();
};
