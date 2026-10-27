import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Prisma, type ProjectRole } from '@prisma/client';
import type { Request } from 'express';
import { ForbiddenError, NotFoundError } from '../../lib/errors';
import { sanitizeFilename } from '../../lib/filename';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../lib/pagination';
import { hasRole } from '../../lib/roles';
import { deleteStoredFiles, storage } from '../../lib/storage';
import * as tasksRepository from '../tasks/tasks.repository';
import * as attachmentsRepository from './attachments.repository';
import type { AttachmentRow } from './attachments.repository';
import type { ListAttachmentsQuery, UploadAttachmentInput } from './attachments.schemas';

type AttachmentRef = NonNullable<Request['attachment']>;

interface Actor {
    userId: string;
    role: ProjectRole;
}

export type AttachmentAction = 'delete';

/** The parts of a multer file the service uses. */
export interface UploadedFile {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
}

/** 404 unless the task exists in this project (a task from another project looks missing). */
async function assertTaskInProject(projectId: string, taskId: string): Promise<void> {
    if (!(await tasksRepository.findTaskRef(projectId, taskId))) {
        throw new NotFoundError('Task');
    }
}

/**
 * Loads the attachment (404 if not in this project) and checks the caller may perform
 * `action`: delete = uploader or ADMIN+ (403 otherwise). Called by loadAttachment.
 */
export async function authorizeAttachmentAction(
    projectId: string,
    attachmentId: string,
    actor: Actor,
    _action: AttachmentAction,
): Promise<AttachmentRef> {
    const attachment = await attachmentsRepository.findAttachmentRef(projectId, attachmentId);
    if (!attachment) {
        throw new NotFoundError('Attachment');
    }
    if (attachment.uploadedById !== actor.userId && !hasRole(actor.role, 'ADMIN')) {
        throw new ForbiddenError();
    }
    return attachment;
}

/**
 * Checks the task first (nothing is written for a bad taskId), writes the bytes under a
 * server-generated key, then inserts the row. If the insert fails the file is removed, so a
 * failed upload never leaves an orphan.
 */
export async function uploadAttachment(
    projectId: string,
    userId: string,
    { taskId }: UploadAttachmentInput,
    file: UploadedFile,
): Promise<AttachmentRow> {
    if (taskId) {
        await assertTaskInProject(projectId, taskId);
    }

    const storageKey = `${projectId}/${randomUUID()}`;
    await storage.put(storageKey, file.buffer);
    try {
        return await attachmentsRepository.createAttachment({
            projectId,
            taskId,
            uploadedById: userId,
            originalName: sanitizeFilename(file.originalname),
            storageKey,
            mimeType: file.mimetype,
            sizeBytes: file.buffer.length,
        });
    } catch (err) {
        await deleteStoredFiles([storageKey]);
        // The task or project was deleted between the check and the insert (FK violation).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
            throw new NotFoundError(taskId ? 'Task' : 'Project');
        }
        throw err;
    }
}

export async function listAttachments(
    projectId: string,
    query: ListAttachmentsQuery,
): Promise<{ items: AttachmentRow[]; meta: PageMeta }> {
    if (query.taskId && query.taskId !== 'none') {
        await assertTaskInProject(projectId, query.taskId);
    }
    const where: Prisma.AttachmentWhereInput = {
        projectId,
        ...(query.taskId === 'none'
            ? { taskId: null }
            : query.taskId
              ? { taskId: query.taskId }
              : {}),
    };
    const { rows, total } = await attachmentsRepository.listAttachments({
        where,
        ...toSkipTake(query),
    });
    return { items: rows, meta: buildPageMeta(total, query.page, query.limit) };
}

export async function getAttachment(
    projectId: string,
    attachmentId: string,
): Promise<AttachmentRow> {
    const attachment = await attachmentsRepository.findAttachment(projectId, attachmentId);
    if (!attachment) {
        throw new NotFoundError('Attachment');
    }
    return attachment;
}

/** Row lookup plus an open stream. 404 if the row is missing or its file is gone. */
export async function openDownload(
    projectId: string,
    attachmentId: string,
): Promise<{
    stream: Readable;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
}> {
    const file = await attachmentsRepository.findAttachmentFile(projectId, attachmentId);
    if (!file) {
        throw new NotFoundError('Attachment');
    }
    if (!(await storage.exists(file.storageKey))) {
        throw new NotFoundError('File');
    }
    const { storageKey, ...meta } = file;
    return { stream: storage.get(storageKey), ...meta };
}

/** `attachment` was loaded and authorised by loadAttachment('delete'). Row first, then file. */
export async function deleteAttachment(attachment: AttachmentRef): Promise<void> {
    await attachmentsRepository.deleteAttachment(attachment.id);
    await deleteStoredFiles([attachment.storageKey]);
}
