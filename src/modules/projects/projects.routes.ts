import { Router } from 'express';
import { paginationQuerySchema } from '../../lib/pagination';
import { authenticate } from '../../middleware/authenticate';
import { loadMembership } from '../../middleware/loadMembership';
import { requireRole } from '../../middleware/requireRole';
import { validate } from '../../middleware/validate';
import * as projectsController from './projects.controller';
import {
    createProjectBodySchema,
    projectIdParamsSchema,
    updateProjectBodySchema,
} from './projects.schemas';

/**
 * Routes under /projects/:projectId owned by other modules (members, invitations, tasks,
 * comments, attachments). Mounted below behind authenticate → validate(projectId) →
 * loadMembership, so `currentMembership(req)` is always set. `mergeParams` lets child routers
 * see `:projectId`.
 */
export const projectScopedRouter = Router({ mergeParams: true });

export const projectsRouter = Router();

projectsRouter.use(authenticate);

const withMembership = [validate({ params: projectIdParamsSchema }), loadMembership];

projectsRouter.post(
    '/',
    validate({ body: createProjectBodySchema }),
    projectsController.createProject,
);
projectsRouter.get(
    '/',
    validate({ query: paginationQuerySchema }),
    projectsController.listMyProjects,
);

projectsRouter.get('/:projectId', ...withMembership, projectsController.getProject);
projectsRouter.patch(
    '/:projectId',
    ...withMembership,
    requireRole('ADMIN'),
    validate({ body: updateProjectBodySchema }),
    projectsController.updateProject,
);
projectsRouter.delete(
    '/:projectId',
    ...withMembership,
    requireRole('OWNER'),
    projectsController.deleteProject,
);

// After the /:projectId routes above, so only deeper paths fall through to it.
projectsRouter.use('/:projectId', ...withMembership, projectScopedRouter);
