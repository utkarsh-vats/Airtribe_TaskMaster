import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as notificationsController from './notifications.controller';
import { listNotificationsQuerySchema, notificationIdParamsSchema } from './notifications.schemas';

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);

notificationsRouter.get(
    '/',
    validate({ query: listNotificationsQuerySchema }),
    notificationsController.listNotifications,
);
notificationsRouter.get('/stream', notificationsController.streamNotifications);
notificationsRouter.post('/read-all', notificationsController.markAllRead);
notificationsRouter.patch(
    '/:notificationId/read',
    validate({ params: notificationIdParamsSchema }),
    notificationsController.markRead,
);
