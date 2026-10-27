import type { Request, Response } from 'express';
import { noContent, ok } from '../../lib/http';
import { currentUserId } from '../../middleware/authenticate';
import { getValidated } from '../../middleware/validate';
import { changePasswordBodySchema, updateMeBodySchema } from './users.schemas';
import * as usersService from './users.service';

export async function getMe(req: Request, res: Response): Promise<void> {
    ok(res, await usersService.getMe(currentUserId(req)));
}

export async function updateMe(req: Request, res: Response): Promise<void> {
    const body = getValidated(req, 'body', updateMeBodySchema);
    ok(res, await usersService.updateMe(currentUserId(req), body));
}

export async function changePassword(req: Request, res: Response): Promise<void> {
    const body = getValidated(req, 'body', changePasswordBodySchema);
    await usersService.changePassword(currentUserId(req), body);
    noContent(res);
}
