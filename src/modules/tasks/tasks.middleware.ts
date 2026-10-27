import type { Request, RequestHandler } from 'express';
import { currentMembership } from '../../middleware/requireRole';
import { getValidated } from '../../middleware/validate';
import { taskIdParamsSchema } from './tasks.schemas';
import * as tasksService from './tasks.service';
import type { TaskAction } from './tasks.service';

/**
 * Runs before body validation so the check order is membership (404) → task in project (404)
 * → permission (403) → body (422). Sets `req.task`. Mount after validate({ params }).
 */
export function loadTask(action: TaskAction): RequestHandler {
    return async (req, _res, next) => {
        const { projectId, userId, role } = currentMembership(req);
        const { taskId } = getValidated(req, 'params', taskIdParamsSchema);
        req.task = await tasksService.authorizeTaskAction(
            projectId,
            taskId,
            { userId, role },
            action,
        );
        next();
    };
}

/** The task loaded by `loadTask()`. */
export function currentTask(req: Request): NonNullable<Request['task']> {
    if (!req.task) {
        throw new Error('req.task is not set; mount loadTask before this handler');
    }
    return req.task;
}
