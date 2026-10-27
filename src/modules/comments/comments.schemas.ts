import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination';
import { uuidParam } from '../../lib/schemas';

export const commentIdParamSchema = uuidParam('commentId');

export const bodySchema = z.string().trim().min(1).max(5000);
export const taskId = z.uuid().nullable();
export const parentId = z.uuid().nullable();

export const createCommentBodySchema = z.strictObject({
    body: bodySchema,
    taskId: taskId.optional(),
    parentId: parentId.optional(),
});

export const updateCommentBodySchema = z.strictObject({
    body: bodySchema,
});

/**
 * `?taskId=<uuid>` → comments on that task only
 * `?taskId=none`   → project-level comments only (taskId IS NULL)
 * omitted           → all comments in the project
 * Unknown params → 422, like the task list.
 */
export const listCommentsQuerySchema = z.strictObject({
    ...paginationQuerySchema.shape,
    taskId: z.union([z.uuid(), z.literal('none')]).optional(),
    parentId: z.union([z.uuid(), z.literal('none')]).optional(),
    order: z.enum(['asc', 'desc']).default('asc'),
});

export type CreateCommentInput = z.infer<typeof createCommentBodySchema>;
export type UpdateCommentInput = z.infer<typeof updateCommentBodySchema>;
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;
