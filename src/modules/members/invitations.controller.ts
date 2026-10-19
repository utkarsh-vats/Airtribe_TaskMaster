import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../../lib/http';
import { currentUserId } from '../../middleware/authenticate';
import { currentMembership } from '../../middleware/requireRole';
import { getValidated } from '../../middleware/validate';
import {
    createInvitationBodySchema,
    invitationIdParamsSchema,
    listInvitationsQuerySchema,
} from './invitations.schemas';
import * as invitationsService from './invitations.service';

// Project-scoped (ADMIN+): /projects/:projectId/invitations

export async function createInvitation(req: Request, res: Response): Promise<void> {
    const { projectId, userId, role } = currentMembership(req);
    const body = getValidated(req, 'body', createInvitationBodySchema);
    created(res, await invitationsService.createInvitation(projectId, { userId, role }, body));
}

export async function listProjectInvitations(req: Request, res: Response): Promise<void> {
    const query = getValidated(req, 'query', listInvitationsQuerySchema);
    const { items, meta } = await invitationsService.listProjectInvitations(
        currentMembership(req).projectId,
        query,
    );
    paginated(res, items, meta);
}

export async function revokeInvitation(req: Request, res: Response): Promise<void> {
    const { invitationId } = getValidated(req, 'params', invitationIdParamsSchema);
    await invitationsService.revokeInvitation(currentMembership(req).projectId, invitationId);
    noContent(res);
}

// Invitee: /users/me/invitations and /invitations/:invitationId/*

export async function listMyInvitations(req: Request, res: Response): Promise<void> {
    ok(res, await invitationsService.listMyInvitations(currentUserId(req)));
}

export async function acceptInvitation(req: Request, res: Response): Promise<void> {
    const { invitationId } = getValidated(req, 'params', invitationIdParamsSchema);
    ok(res, await invitationsService.acceptInvitation(currentUserId(req), invitationId));
}

export async function declineInvitation(req: Request, res: Response): Promise<void> {
    const { invitationId } = getValidated(req, 'params', invitationIdParamsSchema);
    await invitationsService.declineInvitation(currentUserId(req), invitationId);
    noContent(res);
}
