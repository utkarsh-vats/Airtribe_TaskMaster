import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as usersController from './users.controller';
import { changePasswordBodySchema, updateMeBodySchema } from './users.schemas';

export const usersRouter = Router();

usersRouter.use(authenticate);

usersRouter.get('/me', usersController.getMe);
usersRouter.patch('/me', validate({ body: updateMeBodySchema }), usersController.updateMe);
usersRouter.patch(
    '/me/password',
    validate({ body: changePasswordBodySchema }),
    usersController.changePassword,
);
