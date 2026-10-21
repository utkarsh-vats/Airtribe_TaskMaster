import { logger } from './logger';

/** Domain events and their payloads. Published by services after their writes commit. */
export interface DomainEvents {
    'task.assigned': { projectId: string; taskId: string; actorId: string; assigneeId: string };
    'task.completed': { projectId: string; taskId: string; actorId: string };
    'task.updated': {
        projectId: string;
        taskId: string;
        actorId: string;
        changedFields: string[];
    };
    'comment.created': {
        projectId: string;
        taskId: string | null;
        commentId: string;
        actorId: string;
    };
    'invitation.created': {
        projectId: string;
        invitationId: string;
        email: string;
        actorId: string;
    };
}

export type EventName = keyof DomainEvents;
export type EventHandler<E extends EventName> = (payload: DomainEvents[E]) => unknown;

type Registry = { [E in EventName]: Set<EventHandler<E>> };

const handlers: Registry = {
    'task.assigned': new Set(),
    'task.completed': new Set(),
    'task.updated': new Set(),
    'comment.created': new Set(),
    'invitation.created': new Set(),
};

/**
 * Registers `handler` for `event` and returns an unsubscribe function. Handlers are kept in a
 * Set, so subscribing the same function twice is a no-op.
 */
export function subscribe<E extends EventName>(event: E, handler: EventHandler<E>): () => void {
    const set: Set<EventHandler<E>> = handlers[event];
    set.add(handler);
    return () => {
        set.delete(handler);
    };
}

/**
 * Runs every handler for `event` in turn and waits for them. Each runs in its own try/catch:
 * a failing handler is logged and never reaches the caller, so a notification problem can't
 * fail a request whose write already committed. Call it only after the write has committed,
 * never inside $transaction.
 */
export async function publish<E extends EventName>(
    event: E,
    payload: DomainEvents[E],
): Promise<void> {
    const set: Set<EventHandler<E>> = handlers[event];
    for (const handler of [...set]) {
        try {
            await handler(payload);
        } catch (err) {
            logger.error({ err, event, payload }, 'Event handler failed');
        }
    }
}
