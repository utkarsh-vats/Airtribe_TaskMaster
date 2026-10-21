import type { Request, Response } from 'express';
import { noContent, ok } from '../../lib/http';
import { currentMembership } from '../../middleware/requireRole';
import { getValidated } from '../../middleware/validate';
import { memberUserIdParamsSchema, updateMemberRoleBodySchema } from './members.schemas';
import * as membersService from './members.service';

export async function listMembers(req: Request, res: Response): Promise<void> {
    ok(res, await membersService.listMembers(currentMembership(req).projectId));
}

export async function changeRole(req: Request, res: Response): Promise<void> {
    const { projectId, userId, role } = currentMembership(req);
    const { userId: targetUserId } = getValidated(req, 'params', memberUserIdParamsSchema);
    const body = getValidated(req, 'body', updateMemberRoleBodySchema);
    ok(res, await membersService.changeRole(projectId, { userId, role }, targetUserId, body.role));
}

export async function removeMember(req: Request, res: Response): Promise<void> {
    const { projectId, userId, role } = currentMembership(req);
    const { userId: targetUserId } = getValidated(req, 'params', memberUserIdParamsSchema);
    await membersService.removeMember(projectId, { userId, role }, targetUserId);
    noContent(res);
}
