import type { Prisma, ProjectRole } from '@prisma/client';
import type { Request } from 'express';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../lib/pagination';
import { publish } from '../../lib/events';
import { hasRole } from '../../lib/roles';
import * as tasksRepository from '../tasks/tasks.repository';
import * as commentRepository from './comments.repository';
import type { CommentDetailRow, CommentRow } from './comments.repository';
import type { CreateCommentInput, ListCommentsQuery, UpdateCommentInput } from './comments.schemas';

type CommentRef = NonNullable<Request['comment']>;

interface Actor {
    userId: string;
    role: ProjectRole;
}

export type CommentAction = 'edit' | 'delete';

/** GET /comments/:commentId: comment + author { id, name } + task and project summaries. */
export type CommentDetail = CommentDetailRow;

/** 404 unless the task exists in this project (a task from another project looks missing). */
async function assertTaskInProject(projectId: string, taskId: string): Promise<void> {
    if (!(await tasksRepository.findTaskRef(projectId, taskId))) {
        throw new NotFoundError('Task');
    }
}

/**
 * Loads the comment (404 if not found in this project) and checks the caller
 * may perform `action`: only the author may edit; the author **or** an ADMIN+
 * may delete (403 otherwise). Called by the loadComment middleware.
 */
export async function authorizeCommentAction(
    projectId: string,
    commentId: string,
    actor: Actor,
    action: CommentAction,
): Promise<CommentRef> {
    const comment = await commentRepository.findCommentRef({ projectId, commentId });
    if (!comment) {
        throw new NotFoundError('Comment');
    }

    const allowed =
        action === 'edit'
            ? comment.authorId === actor.userId
            : comment.authorId === actor.userId || hasRole(actor.role, 'ADMIN');
    if (!allowed) {
        throw new ForbiddenError();
    }
    return comment;
}

export async function createComment(
    projectId: string,
    userId: string,
    input: CreateCommentInput,
): Promise<CommentRow> {
    if (input.taskId) {
        await assertTaskInProject(projectId, input.taskId);
    }
    let taskId = input.taskId ?? null;
    if (input.parentId) {
        const parent = await commentRepository.findCommentRef({
            projectId,
            commentId: input.parentId,
        });
        if (!parent) {
            throw new NotFoundError('Parent comment');
        }
        if (parent.parentId !== null) {
            throw new ValidationError([
                { path: 'parentId', message: 'Nested comments are not allowed.' },
            ]);
        }
        if (input.taskId !== undefined && parent.taskId !== input.taskId) {
            throw new ValidationError([
                { path: 'taskId', message: 'Parent comment and reply must be in the same task.' },
            ]);
        }
        taskId = parent.taskId;
    }
    const comment = await commentRepository.createComment({
        ...input,
        projectId,
        taskId,
        authorId: userId,
    });
    await publish('comment.created', {
        projectId,
        taskId: comment.taskId,
        commentId: comment.id,
        actorId: userId,
        parentId: comment.parentId,
    });
    return comment;
}

export async function getComment(projectId: string, commentId: string): Promise<CommentDetail> {
    const comment = await commentRepository.getCommentById({ projectId, commentId });
    if (!comment) {
        throw new NotFoundError('Comment');
    }
    return comment;
}

/** `comment` was loaded and authorised by loadComment('edit'). */
export async function updateComment(
    comment: CommentRef,
    input: UpdateCommentInput,
): Promise<CommentRow> {
    return commentRepository.updateComment(comment.projectId, comment.id, {
        ...input,
        editedAt: new Date(),
    });
}

/** `comment` was loaded and authorised by loadComment('delete'). */
export async function deleteComment(comment: CommentRef): Promise<void> {
    await commentRepository.deleteComment({ projectId: comment.projectId, commentId: comment.id });
}

/** Returns shape for list endpoints (includes author; no task/project detail). */
export interface CommentListResult {
    data: CommentRow[];
    meta: PageMeta;
}

/**
 * List comments in a project, optionally filtered by taskId.
 *
 * `taskId` query behaviour (per DESIGN.md §7):
 * - `?taskId=<uuid>`  → comments on that specific task only
 * - `?taskId=none`    → project-level comments only (taskId IS NULL in DB)
 * - omitted           → all comments in the project
 *
 * Any member sees every matching comment. `?taskId=<uuid>` → 404 if the task isn't in this
 * project. Ordered oldest-first, id breaking ties so pages stay stable.
 */
export async function listProjectComments(
    projectId: string,
    query: ListCommentsQuery,
): Promise<CommentListResult> {
    const { skip, take } = toSkipTake(query);
    if (query.taskId && query.taskId !== 'none') {
        await assertTaskInProject(projectId, query.taskId);
    }

    // Build the taskId filter:
    //   'none'  → NULL in DB (project-level comments)
    //   a UUID  → that specific task
    //   absent  → no filter (all comments)
    const taskFilter: Prisma.CommentWhereInput =
        query.taskId === 'none' ? { taskId: null } : query.taskId ? { taskId: query.taskId } : {};

    const parentFilter: Prisma.CommentWhereInput =
        query.parentId === 'none'
            ? { parentId: null }
            : query.parentId
              ? { parentId: query.parentId }
              : {};

    const where: Prisma.CommentWhereInput = {
        projectId,
        ...taskFilter,
        ...parentFilter,
    };

    const orderBy = [{ createdAt: query.order }, { id: query.order }];

    const { rows, total } = await commentRepository.listComments({
        where,
        orderBy,
        skip,
        take,
    });

    return { data: rows, meta: buildPageMeta(total, query.page, query.limit) };
}
