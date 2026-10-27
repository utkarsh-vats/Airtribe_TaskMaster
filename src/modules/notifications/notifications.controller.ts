import type { Request, Response } from 'express';
import { noContent, paginated } from '../../lib/http';
import { currentUserId } from '../../middleware/authenticate';
import { getValidated } from '../../middleware/validate';
import { listNotificationsQuerySchema, notificationIdParamsSchema } from './notifications.schemas';
import * as notificationsService from './notifications.service';
import { openStream } from './sse';

export async function listNotifications(req: Request, res: Response): Promise<void> {
    const query = getValidated(req, 'query', listNotificationsQuerySchema);
    const { items, meta } = await notificationsService.listNotifications(currentUserId(req), query);
    paginated(res, items, meta);
}

/** Long-lived: the response stays open until the client disconnects or the server shuts down. */
export function streamNotifications(req: Request, res: Response): void {
    openStream(currentUserId(req), res);
}

export async function markRead(req: Request, res: Response): Promise<void> {
    const { notificationId } = getValidated(req, 'params', notificationIdParamsSchema);
    await notificationsService.markRead(currentUserId(req), notificationId);
    noContent(res);
}

export async function markAllRead(req: Request, res: Response): Promise<void> {
    await notificationsService.markAllRead(currentUserId(req));
    noContent(res);
}
