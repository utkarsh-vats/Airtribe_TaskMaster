import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination';
import { uuidParam } from '../../lib/schemas';

export const attachmentIdParamsSchema = uuidParam('attachmentId');

/**
 * Text fields of the multipart upload (the file itself is on `req.file`). A request with no
 * body at all leaves `req.body` undefined, hence the default, so the error is about `file`.
 */
export const uploadAttachmentBodySchema = z
    .strictObject({
        taskId: z.uuid().optional(),
    })
    .default({});

/** `?taskId=<uuid>` one task, `?taskId=none` project-level only, omitted = all. */
export const listAttachmentsQuerySchema = z.strictObject({
    ...paginationQuerySchema.shape,
    taskId: z.union([z.uuid(), z.literal('none')]).optional(),
});

export type UploadAttachmentInput = z.infer<typeof uploadAttachmentBodySchema>;
export type ListAttachmentsQuery = z.infer<typeof listAttachmentsQuerySchema>;
