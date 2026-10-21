import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../../lib/http';
import { currentMembership } from '../../middleware/requireRole';
import { getValidated } from '../../middleware/validate';
import {
    commentIdParamSchema,
    createCommentBodySchema,
    listCommentsQuerySchema,
    updateCommentBodySchema,
} from './comments.schemas';
import { currentComment } from './comments.middleware';
import * as commentService from './comments.service';

/**
 * POST /projects/:projectId/comments
 *
 * Creates a project-level comment when `taskId` is absent,
 * or a task comment when `taskId` is provided in the body.
 * The author is always the authenticated user.
 */
export async function createComment(req: Request, res: Response): Promise<void> {
    const { projectId, userId } = currentMembership(req);
    const body = getValidated(req, 'body', createCommentBodySchema);
    const comment = await commentService.createComment(projectId, userId, body);
    created(res, comment);
}

/**
 * GET /projects/:projectId/comments
 *
 * Lists comments in the project, ordered oldest-first.
 * - `?taskId=<uuid>` → comments on that task only
 * - `?taskId=none`   → project-level comments only (no task attached)
 * - omitted          → all comments in the project
 *
 * Any member sees every comment.
 */
export async function listProjectComments(req: Request, res: Response): Promise<void> {
    const { projectId } = currentMembership(req);
    const query = getValidated(req, 'query', listCommentsQuerySchema);
    const { data, meta } = await commentService.listProjectComments(projectId, query);
    paginated(res, data, meta);
}

/**
 * GET /projects/:projectId/comments/:commentId
 * Returns a single comment. Any project member may fetch any comment.
 */
export async function getComment(req: Request, res: Response): Promise<void> {
    const { projectId } = currentMembership(req);
    const { commentId } = getValidated(req, 'params', commentIdParamSchema);
    const comment = await commentService.getComment(projectId, commentId);
    ok(res, comment);
}

/**
 * PATCH /projects/:projectId/comments/:commentId
 * Updates a comment body. Only the original author may edit.
 */
export async function updateComment(req: Request, res: Response): Promise<void> {
    const body = getValidated(req, 'body', updateCommentBodySchema);
    const comment = await commentService.updateComment(currentComment(req), body);
    ok(res, comment);
}

/**
 * DELETE /projects/:projectId/comments/:commentId
 * Deletes a comment. The author may delete their own; ADMIN+ may delete any.
 */
export async function deleteComment(req: Request, res: Response): Promise<void> {
    await commentService.deleteComment(currentComment(req));
    noContent(res);
}
