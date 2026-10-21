import { NotFoundError } from '../../lib/errors';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../lib/pagination';
import * as notificationsRepository from './notifications.repository';
import type { NotificationRow } from './notifications.repository';
import type { ListNotificationsQuery } from './notifications.schemas';

export async function listNotifications(
    userId: string,
    query: ListNotificationsQuery,
): Promise<{ items: NotificationRow[]; meta: PageMeta & { unreadCount: number } }> {
    const { rows, total, unreadCount } = await notificationsRepository.listNotifications(userId, {
        unread: query.unread,
        ...toSkipTake(query),
    });
    return {
        items: rows,
        meta: { ...buildPageMeta(total, query.page, query.limit), unreadCount },
    };
}

/** Idempotent; someone else's or a missing notification is 404. */
export async function markRead(userId: string, notificationId: string): Promise<void> {
    if (!(await notificationsRepository.notificationExists(userId, notificationId))) {
        throw new NotFoundError('Notification');
    }
    await notificationsRepository.markRead(userId, { id: notificationId });
}

export async function markAllRead(userId: string): Promise<void> {
    await notificationsRepository.markRead(userId);
}
