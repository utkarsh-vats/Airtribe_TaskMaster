import type { Prisma, ProjectRole } from '@prisma/client';
import { prisma } from '../../db/prisma';

type Db = Prisma.TransactionClient;

const memberSelect = {
    role: true,
    joinedAt: true,
    user: { select: { id: true, name: true, email: true, avatarUrl: true } },
} satisfies Prisma.ProjectMemberSelect;

export type MemberRow = Prisma.ProjectMemberGetPayload<{ select: typeof memberSelect }>;

/** OWNER, ADMIN, MEMBER (Postgres enums sort in declaration order), then by join date. */
export function listMembers(projectId: string, db: Db = prisma): Promise<MemberRow[]> {
    return db.projectMember.findMany({
        where: { projectId },
        orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }, { userId: 'asc' }],
        select: memberSelect,
    });
}

export function findMemberRole(
    projectId: string,
    userId: string,
    db: Db = prisma,
): Promise<{ role: ProjectRole } | null> {
    return db.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { role: true },
    });
}

/** Changes a member's role only if it currently is `from`. Returns rows changed (0 or 1). */
export async function changeRoleIf(
    db: Db,
    where: { projectId: string; userId: string; from: ProjectRole },
    to: ProjectRole,
): Promise<number> {
    const { count } = await db.projectMember.updateMany({
        where: { projectId: where.projectId, userId: where.userId, role: where.from },
        data: { role: to },
    });
    return count;
}

/** Returns rows deleted (0 or 1). */
export async function deleteMember(db: Db, projectId: string, userId: string): Promise<number> {
    const { count } = await db.projectMember.deleteMany({ where: { projectId, userId } });
    return count;
}

/** Unassigns the user's not-yet-completed tasks in the project. Completed ones keep history. */
export async function unassignOpenTasks(db: Db, projectId: string, userId: string): Promise<void> {
    await db.task.updateMany({
        where: { projectId, assigneeId: userId, status: { not: 'COMPLETED' } },
        data: { assigneeId: null },
    });
}

export async function isMemberByEmail(projectId: string, email: string): Promise<boolean> {
    const member = await prisma.projectMember.findFirst({
        where: { projectId, user: { email } },
        select: { userId: true },
    });
    return member !== null;
}

export async function addMember(
    db: Db,
    data: { projectId: string; userId: string; role: ProjectRole },
): Promise<void> {
    await db.projectMember.create({ data, select: { projectId: true } });
}
