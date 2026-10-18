import { Router } from 'express';

/**
 * Every feature router is mounted here under /api/v1.
 * Steps 4+ add: apiRouter.use('/auth', authRouter), apiRouter.use('/users', usersRouter), ...
 */
export const apiRouter = Router();
