import { Prisma, type ProjectRole, type TaskStatus } from '@prisma/client';
import type { Request } from 'express';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../lib/pagination';
import { hasRole } from '../../lib/roles';
import * as membersRepository from '../members/members.repository';
import {
    buildTaskOrderBy,
    buildTaskWhere,
    type MyTasksQuery,
    type TaskListQuery,
} from './tasks.query';
import * as tasksRepository from './tasks.repository';
import type { MyTaskRow, TaskDetailRow, TaskListRow } from './tasks.repository';
import type { CreateTaskInput, UpdateTaskInput } from './tasks.schemas';

type TaskRef = NonNullable<Request['task']>;

interface Actor {
    userId: string;
    role: ProjectRole;
}

export type TaskAction = 'update' | 'delete';

export interface TaskDetail extends Omit<TaskDetailRow, '_count'> {
    commentCount: number;
    attachmentCount: number;
}

function toDetail({ _count, ...task }: TaskDetailRow): TaskDetail {
    return { ...task, commentCount: _count.comments, attachmentCount: _count.attachments };
}

/** 422 on `assigneeId`, matching how Zod failures are reported. */
async function assertAssignable(projectId: string, assigneeId: string | null | undefined) {
    if (!assigneeId) return;
    if (!(await membersRepository.findMemberRole(projectId, assigneeId))) {
        throw new ValidationError([
            { path: 'assigneeId', message: 'Assignee must be a member of this project' },
        ]);
    }
}

/**
 * Loads the task (404 if not in this project) and checks the caller may perform `action`:
 * update = creator, assignee or ADMIN+; delete = creator or ADMIN+ (403 otherwise).
 */
export async function authorizeTaskAction(
    projectId: string,
    taskId: string,
    actor: Actor,
    action: TaskAction,
): Promise<TaskRef> {
    const task = await tasksRepository.findTaskRef(projectId, taskId);
    if (!task) {
        throw new NotFoundError('Task');
    }

    const allowed =
        hasRole(actor.role, 'ADMIN') ||
        task.createdById === actor.userId ||
        (action === 'update' && task.assigneeId === actor.userId);
    if (!allowed) {
        throw new ForbiddenError();
    }
    return task;
}

export async function createTask(
    projectId: string,
    userId: string,
    input: CreateTaskInput,
): Promise<TaskDetail> {
    await assertAssignable(projectId, input.assigneeId);
    return toDetail(await tasksRepository.createTask({ ...input, projectId, createdById: userId }));
}

export async function getTask(projectId: string, taskId: string): Promise<TaskDetail> {
    const task = await tasksRepository.findTaskDetail(projectId, taskId);
    if (!task) {
        throw new NotFoundError('Task');
    }
    return toDetail(task);
}

/** completedAt follows status: set on entering COMPLETED, cleared on leaving, kept otherwise. */
function completedAtFor(from: TaskStatus, to: TaskStatus | undefined): Date | null | undefined {
    if (to === undefined || to === from) return undefined;
    return to === 'COMPLETED' ? new Date() : null;
}

export async function updateTask(
    projectId: string,
    task: TaskRef,
    input: UpdateTaskInput,
): Promise<TaskDetail> {
    await assertAssignable(projectId, input.assigneeId);

    const completedAt = completedAtFor(task.status, input.status);
    try {
        const updated = await tasksRepository.updateTask(
            task.id,
            { ...input, ...(completedAt !== undefined ? { completedAt } : {}) },
            // Guard on the status we read, so a concurrent status change can't leave
            // status and completedAt disagreeing (the CHECK constraint would reject it).
            input.status !== undefined ? task.status : undefined,
        );
        return toDetail(updated);
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
            throw new ConflictError('The task changed while you were editing it; reload and retry');
        }
        throw err;
    }
}

export async function deleteTask(taskId: string): Promise<void> {
    // Comments and attachment rows go with it via the composite FKs' ON DELETE CASCADE.
    await tasksRepository.deleteTask(taskId);
    // TODO(step 10): delete attachment files from storage after commit
}

export async function listProjectTasks(
    projectId: string,
    userId: string,
    query: TaskListQuery,
): Promise<{ items: TaskListRow[]; meta: PageMeta }> {
    const where = {
        AND: [{ projectId }, buildTaskWhere(query, { userId, now: new Date() })],
    } satisfies Prisma.TaskWhereInput;
    const { rows, total } = await tasksRepository.listTasks({
        where,
        orderBy: buildTaskOrderBy(query),
        ...toSkipTake(query),
    });
    return { items: rows, meta: buildPageMeta(total, query.page, query.limit) };
}

/** Tasks assigned to me, only in projects I'm still a member of. */
export async function listMyTasks(
    userId: string,
    query: MyTasksQuery,
): Promise<{ items: MyTaskRow[]; meta: PageMeta }> {
    const where = {
        AND: [
            { assigneeId: userId },
            { project: { members: { some: { userId } } } },
            buildTaskWhere(query, { userId, now: new Date() }),
        ],
    } satisfies Prisma.TaskWhereInput;
    const { rows, total } = await tasksRepository.listMyTasks({
        where,
        orderBy: buildTaskOrderBy(query),
        ...toSkipTake(query),
    });
    return { items: rows, meta: buildPageMeta(total, query.page, query.limit) };
}
