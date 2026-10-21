import type { InvitationStatus, Prisma, ProjectRole } from '@prisma/client';
import { prisma } from '../../db/prisma';

type Db = Prisma.TransactionClient;

const invitationSelect = {
    id: true,
    projectId: true,
    email: true,
    role: true,
    status: true,
    expiresAt: true,
    respondedAt: true,
    createdAt: true,
    invitedBy: { select: { id: true, name: true } },
} satisfies Prisma.ProjectInvitationSelect;

const myInvitationSelect = {
    ...invitationSelect,
    project: { select: { id: true, name: true } },
} satisfies Prisma.ProjectInvitationSelect;

export type InvitationRow = Prisma.ProjectInvitationGetPayload<{
    select: typeof invitationSelect;
}>;
export type MyInvitationRow = Prisma.ProjectInvitationGetPayload<{
    select: typeof myInvitationSelect;
}>;

/** PENDING and not yet past expiresAt: the only state that can be accepted, declined or revoked. */
const livePending = (now: Date) =>
    ({ status: 'PENDING', expiresAt: { gt: now } }) satisfies Prisma.ProjectInvitationWhereInput;

/**
 * Filter by the status clients see: expiry is lazy, so a PENDING row past expiresAt counts as
 * EXPIRED and not as PENDING.
 */
function effectiveStatusWhere(
    status: InvitationStatus,
    now: Date,
): Prisma.ProjectInvitationWhereInput {
    if (status === 'PENDING') return livePending(now);
    if (status === 'EXPIRED') {
        return { OR: [{ status: 'EXPIRED' }, { status: 'PENDING', expiresAt: { lte: now } }] };
    }
    return { status };
}

/** Marks lapsed PENDING rows for (project, email) EXPIRED so the one-pending index frees up. */
export async function expireStalePending(projectId: string, email: string, now: Date) {
    await prisma.projectInvitation.updateMany({
        where: { projectId, email, status: 'PENDING', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
    });
}

export async function hasLivePending(projectId: string, email: string, now: Date) {
    const row = await prisma.projectInvitation.findFirst({
        where: { projectId, email, ...livePending(now) },
        select: { id: true },
    });
    return row !== null;
}

export function createInvitation(data: {
    projectId: string;
    email: string;
    role: ProjectRole;
    invitedById: string;
    expiresAt: Date;
}): Promise<InvitationRow> {
    return prisma.projectInvitation.create({ data, select: invitationSelect });
}

export async function listProjectInvitations(
    projectId: string,
    { status, skip, take }: { status?: InvitationStatus; skip: number; take: number },
    now: Date,
): Promise<{ rows: InvitationRow[]; total: number }> {
    const where: Prisma.ProjectInvitationWhereInput = {
        projectId,
        ...(status ? effectiveStatusWhere(status, now) : {}),
    };
    const [rows, total] = await prisma.$transaction([
        prisma.projectInvitation.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip,
            take,
            select: invitationSelect,
        }),
        prisma.projectInvitation.count({ where }),
    ]);
    return { rows, total };
}

export function listLivePendingForEmail(email: string, now: Date): Promise<MyInvitationRow[]> {
    return prisma.projectInvitation.findMany({
        where: { email, ...livePending(now) },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: myInvitationSelect,
    });
}

export function findInvitation(id: string, where: { projectId?: string } = {}) {
    return prisma.projectInvitation.findFirst({
        where: { id, ...where },
        select: {
            id: true,
            projectId: true,
            email: true,
            role: true,
            status: true,
            expiresAt: true,
        },
    });
}

/**
 * Moves a live PENDING invitation to `status`. Returns rows changed: 0 means another request
 * got there first (or it just expired).
 */
export async function resolvePending(
    id: string,
    status: 'ACCEPTED' | 'DECLINED' | 'REVOKED',
    now: Date,
    db: Db = prisma,
): Promise<number> {
    const { count } = await db.projectInvitation.updateMany({
        where: { id, ...livePending(now) },
        data: { status, ...(status === 'REVOKED' ? {} : { respondedAt: now }) },
    });
    return count;
}
