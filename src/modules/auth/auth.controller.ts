import type { Request, Response } from 'express';
import { created, noContent, ok } from '../../lib/http';
import { currentUserId } from '../../middleware/authenticate';
import { getValidated } from '../../middleware/validate';
import { loginBodySchema, refreshTokenBodySchema, registerBodySchema } from './auth.schemas';
import * as authService from './auth.service';

export async function register(req: Request, res: Response): Promise<void> {
    const body = getValidated(req, 'body', registerBodySchema);
    created(res, await authService.register(body));
}

export async function login(req: Request, res: Response): Promise<void> {
    const body = getValidated(req, 'body', loginBodySchema);
    ok(res, await authService.login(body, req.get('user-agent')));
}

export async function refresh(req: Request, res: Response): Promise<void> {
    const { refreshToken } = getValidated(req, 'body', refreshTokenBodySchema);
    ok(res, await authService.refresh(refreshToken, req.get('user-agent')));
}

export async function logout(req: Request, res: Response): Promise<void> {
    const { refreshToken } = getValidated(req, 'body', refreshTokenBodySchema);
    await authService.logout(refreshToken);
    noContent(res);
}

export async function logoutAll(req: Request, res: Response): Promise<void> {
    await authService.logoutAll(currentUserId(req));
    noContent(res);
}
