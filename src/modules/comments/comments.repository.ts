import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';

const commentFields = {
    id: true,
    projectId: true,
    taskId: true,
    authorId: true,
    parentId: true,
    body: true,
    editedAt: true,
    createdAt: true,
} satisfies Prisma.CommentSelect;

/** List items and POST/PATCH responses: the comment plus author { id, name }. */
const commentSelect = {
    ...commentFields,
    author: { select: { id: true, name: true } },
    _count: { select: { replies: true } },
} satisfies Prisma.CommentSelect;

/** GET /comments/:commentId: also the task and project summaries. */
const commentDetailSelect = {
    ...commentSelect,
    task: { select: { id: true, title: true, description: true } },
    project: { select: { id: true, name: true } },
} satisfies Prisma.CommentSelect;

function withReplyCount<T extends { _count: { replies: number } }>({
    _count,
    ...rest
}: T): Omit<T, '_count'> & { replyCount: number } {
    return { ...rest, replyCount: _count.replies };
}

type CommentRecord = Prisma.CommentGetPayload<{ select: typeof commentSelect }>;
type CommentDetailRecord = Prisma.CommentGetPayload<{ select: typeof commentDetailSelect }>;
export type CommentRow = Omit<CommentRecord, '_count'> & { replyCount: number };
export type CommentDetailRow = Omit<CommentDetailRecord, '_count'> & { replyCount: number };

interface Page {
    where: Prisma.CommentWhereInput;
    orderBy: Prisma.CommentOrderByWithRelationInput[];
    skip: number;
    take: number;
}

export async function listComments({
    where,
    orderBy,
    skip,
    take,
}: Page): Promise<{ rows: CommentRow[]; total: number }> {
    const [rows, total] = await prisma.$transaction([
        prisma.comment.findMany({ where, orderBy, skip, take, select: commentSelect }),
        prisma.comment.count({ where }),
    ]);
    return { rows: rows.map(withReplyCount), total };
}

export async function createComment(data: {
    projectId: string;
    taskId?: string | null;
    authorId: string;
    parentId?: string | null;
    body: string;
}): Promise<CommentRow> {
    return prisma.comment.create({ data, select: commentSelect }).then(withReplyCount);
}
export async function updateComment(
    projectId: string,
    commentId: string,
    data: {
        body: string;
        editedAt: Date;
    },
): Promise<CommentRow> {
    return prisma.comment
        .update({
            where: { id: commentId, projectId },
            data,
            select: commentSelect,
        })
        .then(withReplyCount);
}
export async function deleteComment({
    projectId,
    commentId,
}: {
    projectId: string;
    commentId: string;
}) {
    await prisma.comment.delete({ where: { id: commentId, projectId } });
}

/** The fields permission checks need. */
export async function findCommentRef({
    projectId,
    commentId,
}: {
    projectId: string;
    commentId: string;
}) {
    return prisma.comment.findUnique({
        where: { id: commentId, projectId },
        select: { id: true, projectId: true, taskId: true, authorId: true, parentId: true },
    });
}

export async function getCommentById({
    projectId,
    commentId,
}: {
    projectId: string;
    commentId: string;
}): Promise<CommentDetailRow | null> {
    const row = await prisma.comment.findUnique({
        where: { id: commentId, projectId },
        select: commentDetailSelect,
    });
    return row ? withReplyCount(row) : null;
}
