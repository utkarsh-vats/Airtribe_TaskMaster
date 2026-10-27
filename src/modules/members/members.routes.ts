import { Router } from 'express';
import { requireRole } from '../../middleware/requireRole';
import { validate } from '../../middleware/validate';
import * as membersController from './members.controller';
import { memberUserIdParamsSchema, updateMemberRoleBodySchema } from './members.schemas';

/** Mounted at /projects/:projectId/members on projectScopedRouter (membership already loaded). */
export const membersRouter = Router({ mergeParams: true });

membersRouter.get('/', membersController.listMembers);
membersRouter.patch(
    '/:userId',
    requireRole('OWNER'),
    validate({ params: memberUserIdParamsSchema, body: updateMemberRoleBodySchema }),
    membersController.changeRole,
);
// Any member may call it to leave; removing others is checked in the service.
membersRouter.delete(
    '/:userId',
    validate({ params: memberUserIdParamsSchema }),
    membersController.removeMember,
);
