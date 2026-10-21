import type { Prisma, TaskPriority, TaskStatus } from '@prisma/client';
import { prisma } from '../../db/prisma';

const taskFields = {
    id: true,
    projectId: true,
    title: true,
    description: true,
    status: true,
    priority: true,
    dueDate: true,
    completedAt: true,
    createdAt: true,
    updatedAt: true,
} satisfies Prisma.TaskSelect;

const taskListSelect = {
    ...taskFields,
    assignee: { select: { id: true, name: true } },
    createdBy: { select: { id: true, name: true } },
} satisfies Prisma.TaskSelect;

const myTaskSelect = {
    ...taskListSelect,
    project: { select: { id: true, name: true } },
} satisfies Prisma.TaskSelect;

const taskDetailSelect = {
    ...taskFields,
    assignee: { select: { id: true, name: true, email: true } },
    createdBy: { select: { id: true, name: true, email: true } },
    _count: { select: { comments: true, attachments: true } },
} satisfies Prisma.TaskSelect;

export type TaskListRow = Prisma.TaskGetPayload<{ select: typeof taskListSelect }>;
export type MyTaskRow = Prisma.TaskGetPayload<{ select: typeof myTaskSelect }>;
export type TaskDetailRow = Prisma.TaskGetPayload<{ select: typeof taskDetailSelect }>;

interface Page {
    where: Prisma.TaskWhereInput;
    orderBy: Prisma.TaskOrderByWithRelationInput[];
    skip: number;
    take: number;
}

export async function listTasks({
    where,
    orderBy,
    skip,
    take,
}: Page): Promise<{ rows: TaskListRow[]; total: number }> {
    const [rows, total] = await prisma.$transaction([
        prisma.task.findMany({ where, orderBy, skip, take, select: taskListSelect }),
        prisma.task.count({ where }),
    ]);
    return { rows, total };
}

export async function listMyTasks({
    where,
    orderBy,
    skip,
    take,
}: Page): Promise<{ rows: MyTaskRow[]; total: number }> {
    const [rows, total] = await prisma.$transaction([
        prisma.task.findMany({ where, orderBy, skip, take, select: myTaskSelect }),
        prisma.task.count({ where }),
    ]);
    return { rows, total };
}

/** The fields permission checks, completion logic and change detection need. */
export function findTaskRef(projectId: string, taskId: string) {
    return prisma.task.findFirst({
        where: { id: taskId, projectId },
        select: {
            id: true,
            createdById: true,
            assigneeId: true,
            status: true,
            title: true,
            description: true,
            priority: true,
            dueDate: true,
        },
    });
}

export function findTaskDetail(projectId: string, taskId: string): Promise<TaskDetailRow | null> {
    return prisma.task.findFirst({ where: { id: taskId, projectId }, select: taskDetailSelect });
}

export function createTask(data: {
    projectId: string;
    createdById: string;
    title: string;
    description?: string | null;
    dueDate?: Date | null;
    priority: TaskPriority;
    assigneeId?: string | null;
}): Promise<TaskDetailRow> {
    return prisma.task.create({ data, select: taskDetailSelect });
}

/**
 * `expectedStatus`, when given, makes the update apply only if the status hasn't changed since
 * it was read (P2025 otherwise), so status and completedAt can't be computed from stale state.
 */
export function updateTask(
    id: string,
    data: {
        title?: string;
        description?: string | null;
        dueDate?: Date | null;
        priority?: TaskPriority;
        status?: TaskStatus;
        completedAt?: Date | null;
        assigneeId?: string | null;
    },
    expectedStatus?: TaskStatus,
): Promise<TaskDetailRow> {
    return prisma.task.update({
        where: { id, ...(expectedStatus ? { status: expectedStatus } : {}) },
        data,
        select: taskDetailSelect,
    });
}

/**
 * Deletes the task (comments and attachment rows cascade) and returns the storage keys of the
 * attachments that went with it. The task row is locked first: an upload for this task then
 * waits on its foreign-key check and fails once the task is gone, so no attachment can slip in
 * between collecting the keys and the delete.
 */
export function deleteTaskReturningStorageKeys(id: string): Promise<string[]> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM tasks WHERE id = ${id}::uuid FOR UPDATE`;
        const attachments = await tx.attachment.findMany({
            where: { taskId: id },
            select: { storageKey: true },
        });
        await tx.task.delete({ where: { id }, select: { id: true } });
        return attachments.map((a) => a.storageKey);
    });
}
