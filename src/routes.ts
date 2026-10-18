import { Router } from 'express';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';

/**
 * Every feature router is mounted here under /api/v1.
 * Later steps add: apiRouter.use('/projects', projectsRouter), ...
 */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
