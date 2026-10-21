import type { Request, RequestHandler } from 'express';
import { currentMembership } from '../../middleware/requireRole';
import { getValidated } from '../../middleware/validate';
import { commentIdParamSchema } from './comments.schemas';
import * as commentService from './comments.service';
import type { CommentAction } from './comments.service';

/**
 * Runs before body validation so the check order is comment in project (404) → permission
 * (403) → body (422). Sets `req.comment`. Mount after validate({ params }).
 */
export function loadComment(action: CommentAction): RequestHandler {
    return async (req, _res, next) => {
        const { projectId, userId, role } = currentMembership(req);
        const { commentId } = getValidated(req, 'params', commentIdParamSchema);
        req.comment = await commentService.authorizeCommentAction(
            projectId,
            commentId,
            { userId, role },
            action,
        );
        next();
    };
}

/** The comment loaded by `loadComment()`. */
export function currentComment(req: Request): NonNullable<Request['comment']> {
    if (!req.comment) {
        throw new Error('req.comment is not set; mount loadComment before this handler');
    }
    return req.comment;
}
