import type { Request, Response } from 'express';
import { ok } from '../../lib/http';
import { getValidated } from '../../middleware/validate';
import { taskDescriptionBodySchema } from './ai.schemas';
import * as aiService from './ai.service';

export async function suggestTaskDescription(req: Request, res: Response): Promise<void> {
    const body = getValidated(req, 'body', taskDescriptionBodySchema);
    ok(res, { description: await aiService.suggestTaskDescription(body) });
}
