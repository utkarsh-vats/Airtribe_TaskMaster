import type { NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';

const notificationSelect = {
    id: true,
    type: true,
    projectId: true,
    taskId: true,
    payload: true,
    readAt: true,
    createdAt: true,
} satisfies Prisma.NotificationSelect;

export type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof notificationSelect }>;

export function createNotifications(
    rows: {
        recipientId: string;
        type: NotificationType;
        projectId: string;
        taskId: string | null;
        payload: Prisma.InputJsonObject;
    }[],
): Promise<(NotificationRow & { recipientId: string })[]> {
    return prisma.notification.createManyAndReturn({
        data: rows,
        select: { ...notificationSelect, recipientId: true },
    });
}

export async function listNotifications(
    recipientId: string,
    { unread, skip, take }: { unread?: boolean; skip: number; take: number },
): Promise<{ rows: NotificationRow[]; total: number; unreadCount: number }> {
    const where: Prisma.NotificationWhereInput = {
        recipientId,
        ...(unread === true ? { readAt: null } : unread === false ? { readAt: { not: null } } : {}),
    };
    const [rows, total, unreadCount] = await prisma.$transaction([
        prisma.notification.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip,
            take,
            select: notificationSelect,
        }),
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { recipientId, readAt: null } }),
    ]);
    return { rows, total, unreadCount };
}

export async function notificationExists(recipientId: string, id: string): Promise<boolean> {
    const row = await prisma.notification.findFirst({
        where: { id, recipientId },
        select: { id: true },
    });
    return row !== null;
}

/** Marks unread notifications read; already-read ones keep their original readAt. */
export async function markRead(recipientId: string, where: { id?: string } = {}): Promise<void> {
    await prisma.notification.updateMany({
        where: { recipientId, readAt: null, ...where },
        data: { readAt: new Date() },
    });
}

// Lookups for the listener's payload snapshot.

export function findUserSummary(id: string) {
    return prisma.user.findUnique({ where: { id }, select: { id: true, name: true } });
}

export function findUserIdByEmail(email: string) {
    return prisma.user.findUnique({ where: { email }, select: { id: true } });
}

export function findProjectSummary(id: string) {
    return prisma.project.findUnique({ where: { id }, select: { id: true, name: true } });
}

export function findTaskPeople(id: string) {
    return prisma.task.findUnique({
        where: { id },
        select: { id: true, title: true, createdById: true, assigneeId: true },
    });
}

export function findCommentBody(id: string) {
    return prisma.comment.findUnique({ where: { id }, select: { body: true } });
}

export function findCommentAuthor(projectId: string, commentId: string) {
    return prisma.comment.findUnique({
        where: { id: commentId, projectId: projectId },
        select: { authorId: true },
    });
}

export function findInvitationRole(id: string) {
    return prisma.projectInvitation.findUnique({ where: { id }, select: { role: true } });
}
