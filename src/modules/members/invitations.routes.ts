import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { validate } from '../../middleware/validate';
import * as invitationsController from './invitations.controller';
import {
    createInvitationBodySchema,
    invitationIdParamsSchema,
    listInvitationsQuerySchema,
} from './invitations.schemas';

/** Mounted at /projects/:projectId/invitations on projectScopedRouter. All ADMIN+. */
export const projectInvitationsRouter = Router({ mergeParams: true });

projectInvitationsRouter.use(requireRole('ADMIN'));

projectInvitationsRouter.post(
    '/',
    validate({ body: createInvitationBodySchema }),
    invitationsController.createInvitation,
);
projectInvitationsRouter.get(
    '/',
    validate({ query: listInvitationsQuerySchema }),
    invitationsController.listProjectInvitations,
);
projectInvitationsRouter.delete(
    '/:invitationId',
    validate({ params: invitationIdParamsSchema }),
    invitationsController.revokeInvitation,
);

/** Mounted at /invitations: the invitee responds. */
export const invitationsRouter = Router();

invitationsRouter.use(authenticate);

invitationsRouter.post(
    '/:invitationId/accept',
    validate({ params: invitationIdParamsSchema }),
    invitationsController.acceptInvitation,
);
invitationsRouter.post(
    '/:invitationId/decline',
    validate({ params: invitationIdParamsSchema }),
    invitationsController.declineInvitation,
);
