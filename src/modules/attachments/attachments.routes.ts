import { Router } from 'express';
import { uploadSingleFile } from '../../middleware/upload';
import { validate } from '../../middleware/validate';
import * as attachmentsController from './attachments.controller';
import { loadAttachment } from './attachments.middleware';
import {
    attachmentIdParamsSchema,
    listAttachmentsQuerySchema,
    uploadAttachmentBodySchema,
} from './attachments.schemas';

/** Mounted at /projects/:projectId/attachments on projectScopedRouter (membership loaded). */
export const attachmentsRouter = Router({ mergeParams: true });

// Membership is checked before multer reads the body, so non-members never get buffered.
attachmentsRouter.post(
    '/',
    uploadSingleFile,
    validate({ body: uploadAttachmentBodySchema }),
    attachmentsController.uploadAttachment,
);
attachmentsRouter.get(
    '/',
    validate({ query: listAttachmentsQuerySchema }),
    attachmentsController.listAttachments,
);
attachmentsRouter.get(
    '/:attachmentId',
    validate({ params: attachmentIdParamsSchema }),
    attachmentsController.getAttachment,
);
attachmentsRouter.get(
    '/:attachmentId/download',
    validate({ params: attachmentIdParamsSchema }),
    attachmentsController.downloadAttachment,
);
attachmentsRouter.delete(
    '/:attachmentId',
    validate({ params: attachmentIdParamsSchema }),
    loadAttachment('delete'),
    attachmentsController.deleteAttachment,
);
