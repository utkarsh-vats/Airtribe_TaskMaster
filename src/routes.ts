import { Router } from 'express';
import { authRouter } from './modules/auth/auth.routes';

/**
 * Every feature router is mounted here under /api/v1.
 * Later steps add: apiRouter.use('/users', usersRouter), apiRouter.use('/projects', ...), ...
 */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
