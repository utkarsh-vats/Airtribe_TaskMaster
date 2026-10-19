import { Router } from 'express';
import { authRouter } from './modules/auth/auth.routes';
import { projectsRouter } from './modules/projects/projects.routes';
import { usersRouter } from './modules/users/users.routes';

/**
 * Every feature router is mounted here under /api/v1.
 * Project sub-resources (members, tasks, ...) attach to `projectScopedRouter` in
 * modules/projects/projects.routes.ts instead.
 */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/projects', projectsRouter);
