import { Router } from 'express';
import { validate } from '../../middleware/validate';
import {
    commentIdParamSchema,
    createCommentBodySchema,
    listCommentsQuerySchema,
    updateCommentBodySchema,
} from './comments.schemas';
import * as commentsController from './comments.controller';
import { loadComment } from './comments.middleware';

/** Mounted at /projects/:projectId/comments (membership already loaded via projectScopedRouter). */
export const commentsRouter = Router({ mergeParams: true });

// POST '/' — create a comment (project-level or task-scoped via body.taskId)
commentsRouter.post(
    '/',
    validate({ body: createCommentBodySchema }),
    commentsController.createComment,
);

// GET '/' — list comments; ?taskId=<uuid> task-only, ?taskId=none project-only, omit=all
commentsRouter.get(
    '/',
    validate({ query: listCommentsQuerySchema }),
    commentsController.listProjectComments,
);

// GET '/:commentId' — fetch a single comment
commentsRouter.get(
    '/:commentId',
    validate({ params: commentIdParamSchema }),
    commentsController.getComment,
);

// PATCH '/:commentId' — edit comment body (author only).
// loadComment runs before the body is validated: 404 → 403 → 422.
commentsRouter.patch(
    '/:commentId',
    validate({ params: commentIdParamSchema }),
    loadComment('edit'),
    validate({ body: updateCommentBodySchema }),
    commentsController.updateComment,
);

// DELETE '/:commentId' — delete a comment (author or ADMIN+)
commentsRouter.delete(
    '/:commentId',
    validate({ params: commentIdParamSchema }),
    loadComment('delete'),
    commentsController.deleteComment,
);
