import { Router } from 'express';
import { validate } from '../../middleware/validate';
import * as tasksController from './tasks.controller';
import { loadTask } from './tasks.middleware';
import { taskListQuerySchema } from './tasks.query';
import { createTaskBodySchema, taskIdParamsSchema, updateTaskBodySchema } from './tasks.schemas';

/** Mounted at /projects/:projectId/tasks on projectScopedRouter (membership already loaded). */
export const tasksRouter = Router({ mergeParams: true });

tasksRouter.post('/', validate({ body: createTaskBodySchema }), tasksController.createTask);
tasksRouter.get('/', validate({ query: taskListQuerySchema }), tasksController.listProjectTasks);

tasksRouter.get('/:taskId', validate({ params: taskIdParamsSchema }), tasksController.getTask);
// loadTask runs before the body is validated: 404 → 403 → 422.
tasksRouter.patch(
    '/:taskId',
    validate({ params: taskIdParamsSchema }),
    loadTask('update'),
    validate({ body: updateTaskBodySchema }),
    tasksController.updateTask,
);
tasksRouter.delete(
    '/:taskId',
    validate({ params: taskIdParamsSchema }),
    loadTask('delete'),
    tasksController.deleteTask,
);
