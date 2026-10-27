import type { NotificationType, Prisma } from '@prisma/client';
import { subscribe } from '../../lib/events';
import * as notificationsRepository from './notifications.repository';
import { pushToUser } from './sse';

const PREVIEW_LENGTH = 140;

/** Recipients minus the actor, without duplicates or nulls. */
function recipients(actorId: string, ...userIds: (string | null)[]): string[] {
    return [...new Set(userIds)].filter((id): id is string => id !== null && id !== actorId);
}

/**
 * Inserts one notification per recipient with a payload snapshot (names as they are now, so
 * later renames don't rewrite history), then pushes each to the recipient's open streams.
 */
async function notify(
    recipientIds: string[],
    type: NotificationType,
    {
        projectId,
        taskId,
        actorId,
        extra = {},
    }: {
        projectId: string;
        taskId: string | null;
        actorId: string;
        extra?: Prisma.InputJsonObject;
    },
    task?: { id: string; title: string },
): Promise<void> {
    if (recipientIds.length === 0) return;

    const [actor, project] = await Promise.all([
        notificationsRepository.findUserSummary(actorId),
        notificationsRepository.findProjectSummary(projectId),
    ]);
    if (!project) return; // deleted in the meantime: nothing to point at

    const payload: Prisma.InputJsonObject = {
        actor: actor ?? { id: actorId, name: null },
        project,
        ...(task ? { task: { id: task.id, title: task.title } } : {}),
        ...extra,
    };
    const rows = await notificationsRepository.createNotifications(
        recipientIds.map((recipientId) => ({ recipientId, type, projectId, taskId, payload })),
    );
    for (const { recipientId, ...notification } of rows) {
        pushToUser(recipientId, notification);
    }
}

/** Notifies about a task event: `pick` chooses recipients from the task's people. */
async function notifyAboutTask(
    event: { projectId: string; taskId: string; actorId: string },
    type: NotificationType,
    pick: (task: { createdById: string; assigneeId: string | null }) => (string | null)[],
    extra?: Prisma.InputJsonObject,
): Promise<void> {
    const task = await notificationsRepository.findTaskPeople(event.taskId);
    if (!task) return;
    await notify(recipients(event.actorId, ...pick(task)), type, { ...event, extra }, task);
}

let registered = false;

/**
 * Subscribes the notification handlers to the event bus. Idempotent: createApp() calls it, and
 * tests create many apps in one process.
 */
export function registerNotificationListeners(): void {
    if (registered) return;
    registered = true;

    subscribe('task.assigned', (e) => notifyAboutTask(e, 'TASK_ASSIGNED', () => [e.assigneeId]));

    subscribe('task.completed', (e) =>
        notifyAboutTask(e, 'TASK_COMPLETED', (t) => [t.createdById, t.assigneeId]),
    );

    subscribe('task.updated', (e) =>
        notifyAboutTask(e, 'TASK_UPDATED', (t) => [t.createdById, t.assigneeId], {
            changedFields: e.changedFields,
        }),
    );

    subscribe('comment.created', async (e) => {
        const comment = await notificationsRepository.findCommentBody(e.commentId);
        const preview = Array.from(comment?.body ?? '')
            .slice(0, PREVIEW_LENGTH)
            .join('');

        // If the comment is a reply, notify the parent comment's author
        let replyRecipient: string | null = null;
        if (e.parentId !== null) {
            const parent = await notificationsRepository.findCommentAuthor(e.projectId, e.parentId);
            if (parent && parent.authorId !== e.actorId) {
                replyRecipient = parent.authorId;
                const task = e.taskId
                    ? await notificationsRepository.findTaskPeople(e.taskId)
                    : null;
                await notify(
                    [replyRecipient],
                    'COMMENT_REPLY',
                    {
                        projectId: e.projectId,
                        taskId: e.taskId,
                        actorId: e.actorId,
                        extra: {
                            commentId: e.commentId,
                            parentId: e.parentId,
                            commentPreview: preview,
                        },
                    },
                    task ?? undefined,
                );
            }
        }

        // Project-level comments notify nobody: there's no task audience.
        if (e.taskId === null) return;
        await notifyAboutTask(
            { projectId: e.projectId, taskId: e.taskId, actorId: e.actorId },
            'COMMENT_ADDED',
            (t) => [t.createdById, t.assigneeId].filter((id) => id !== replyRecipient),
            { commentId: e.commentId, commentPreview: preview },
        );
    });

    subscribe('invitation.created', async (e) => {
        // Only people who already have an account; others see it in-app after registering.
        const [user, invitation] = await Promise.all([
            notificationsRepository.findUserIdByEmail(e.email),
            notificationsRepository.findInvitationRole(e.invitationId),
        ]);
        if (!user || !invitation) return;
        await notify(recipients(e.actorId, user.id), 'PROJECT_INVITATION', {
            projectId: e.projectId,
            taskId: null,
            actorId: e.actorId,
            extra: { invitationId: e.invitationId, role: invitation.role },
        });
    });
}
