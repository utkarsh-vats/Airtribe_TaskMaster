import type { Request, RequestHandler } from 'express';
import { currentMembership } from '../../middleware/requireRole';
import { getValidated } from '../../middleware/validate';
import { attachmentIdParamsSchema } from './attachments.schemas';
import * as attachmentsService from './attachments.service';
import type { AttachmentAction } from './attachments.service';

/**
 * Check order: attachment in project (404) → permission (403). Sets `req.attachment`.
 * Mount after validate({ params }).
 */
export function loadAttachment(action: AttachmentAction): RequestHandler {
    return async (req, _res, next) => {
        const { projectId, userId, role } = currentMembership(req);
        const { attachmentId } = getValidated(req, 'params', attachmentIdParamsSchema);
        req.attachment = await attachmentsService.authorizeAttachmentAction(
            projectId,
            attachmentId,
            { userId, role },
            action,
        );
        next();
    };
}

/** The attachment loaded by `loadAttachment()`. */
export function currentAttachment(req: Request): NonNullable<Request['attachment']> {
    if (!req.attachment) {
        throw new Error('req.attachment is not set; mount loadAttachment before this handler');
    }
    return req.attachment;
}
