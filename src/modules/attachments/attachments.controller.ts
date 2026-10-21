import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { ValidationError } from '../../lib/errors';
import { created, noContent, ok, paginated } from '../../lib/http';
import { currentMembership } from '../../middleware/requireRole';
import { getValidated } from '../../middleware/validate';
import { currentAttachment } from './attachments.middleware';
import {
    attachmentIdParamsSchema,
    listAttachmentsQuerySchema,
    uploadAttachmentBodySchema,
} from './attachments.schemas';
import * as attachmentsService from './attachments.service';

export async function uploadAttachment(req: Request, res: Response): Promise<void> {
    const { projectId, userId } = currentMembership(req);
    const body = getValidated(req, 'body', uploadAttachmentBodySchema);
    if (!req.file) {
        throw new ValidationError([{ path: 'file', message: 'A file is required' }]);
    }
    created(res, await attachmentsService.uploadAttachment(projectId, userId, body, req.file));
}

export async function listAttachments(req: Request, res: Response): Promise<void> {
    const query = getValidated(req, 'query', listAttachmentsQuerySchema);
    const { items, meta } = await attachmentsService.listAttachments(
        currentMembership(req).projectId,
        query,
    );
    paginated(res, items, meta);
}

export async function getAttachment(req: Request, res: Response): Promise<void> {
    const { attachmentId } = getValidated(req, 'params', attachmentIdParamsSchema);
    ok(res, await attachmentsService.getAttachment(currentMembership(req).projectId, attachmentId));
}

/** Streams the file as a download: stored MIME type, exact length, original filename. */
export async function downloadAttachment(req: Request, res: Response): Promise<void> {
    const { attachmentId } = getValidated(req, 'params', attachmentIdParamsSchema);
    const { stream, originalName, mimeType, sizeBytes } = await attachmentsService.openDownload(
        currentMembership(req).projectId,
        attachmentId,
    );

    // res.attachment encodes non-ASCII names (filename*=UTF-8''…) and guesses a type from the
    // extension; the stored type set after it wins.
    res.attachment(originalName);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(sizeBytes));

    try {
        await pipeline(stream, res);
    } catch (err) {
        // Before any bytes were sent the error handler can still answer; afterwards the
        // client has already been cut off (usually because it disconnected).
        if (!res.headersSent) throw err;
        req.log.warn({ err }, 'Attachment download interrupted');
    }
}

export async function deleteAttachment(req: Request, res: Response): Promise<void> {
    await attachmentsService.deleteAttachment(currentAttachment(req));
    noContent(res);
}
