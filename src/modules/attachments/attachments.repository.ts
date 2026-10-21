import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';

/** The metadata clients see. `storageKey` never leaves the server. */
const attachmentSelect = {
    id: true,
    originalName: true,
    mimeType: true,
    sizeBytes: true,
    taskId: true,
    createdAt: true,
    uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.AttachmentSelect;

export type AttachmentRow = Prisma.AttachmentGetPayload<{ select: typeof attachmentSelect }>;

export async function listAttachments({
    where,
    skip,
    take,
}: {
    where: Prisma.AttachmentWhereInput;
    skip: number;
    take: number;
}): Promise<{ rows: AttachmentRow[]; total: number }> {
    const [rows, total] = await prisma.$transaction([
        prisma.attachment.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip,
            take,
            select: attachmentSelect,
        }),
        prisma.attachment.count({ where }),
    ]);
    return { rows, total };
}

export function createAttachment(data: {
    projectId: string;
    taskId?: string;
    uploadedById: string;
    originalName: string;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
}): Promise<AttachmentRow> {
    return prisma.attachment.create({ data, select: attachmentSelect });
}

export function findAttachment(projectId: string, attachmentId: string) {
    return prisma.attachment.findFirst({
        where: { id: attachmentId, projectId },
        select: attachmentSelect,
    });
}

/** The fields permission checks and file access need. */
export function findAttachmentRef(projectId: string, attachmentId: string) {
    return prisma.attachment.findFirst({
        where: { id: attachmentId, projectId },
        select: { id: true, projectId: true, uploadedById: true, storageKey: true },
    });
}

/** What a download needs: where the bytes are and how to label them. */
export function findAttachmentFile(projectId: string, attachmentId: string) {
    return prisma.attachment.findFirst({
        where: { id: attachmentId, projectId },
        select: { storageKey: true, originalName: true, mimeType: true, sizeBytes: true },
    });
}

export async function deleteAttachment(id: string): Promise<void> {
    await prisma.attachment.delete({ where: { id }, select: { id: true } });
}
