import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../../lib/http';
import { currentUserId } from '../../middleware/authenticate';
import { currentMembership } from '../../middleware/requireRole';
import { getValidated } from '../../middleware/validate';
import { currentTask } from './tasks.middleware';
import { myTasksQuerySchema, taskListQuerySchema } from './tasks.query';
import { createTaskBodySchema, taskIdParamsSchema, updateTaskBodySchema } from './tasks.schemas';
import * as tasksService from './tasks.service';

export async function createTask(req: Request, res: Response): Promise<void> {
    const { projectId, userId } = currentMembership(req);
    const body = getValidated(req, 'body', createTaskBodySchema);
    created(res, await tasksService.createTask(projectId, userId, body));
}

export async function listProjectTasks(req: Request, res: Response): Promise<void> {
    const { projectId, userId } = currentMembership(req);
    const query = getValidated(req, 'query', taskListQuerySchema);
    const { items, meta } = await tasksService.listProjectTasks(projectId, userId, query);
    paginated(res, items, meta);
}

export async function getTask(req: Request, res: Response): Promise<void> {
    const { taskId } = getValidated(req, 'params', taskIdParamsSchema);
    ok(res, await tasksService.getTask(currentMembership(req).projectId, taskId));
}

export async function updateTask(req: Request, res: Response): Promise<void> {
    const body = getValidated(req, 'body', updateTaskBodySchema);
    ok(
        res,
        await tasksService.updateTask(
            currentMembership(req).projectId,
            currentMembership(req).userId,
            currentTask(req),
            body,
        ),
    );
}

export async function deleteTask(req: Request, res: Response): Promise<void> {
    await tasksService.deleteTask(currentTask(req).id);
    noContent(res);
}

/** GET /users/me/tasks */
export async function listMyTasks(req: Request, res: Response): Promise<void> {
    const query = getValidated(req, 'query', myTasksQuerySchema);
    const { items, meta } = await tasksService.listMyTasks(currentUserId(req), query);
    paginated(res, items, meta);
}
