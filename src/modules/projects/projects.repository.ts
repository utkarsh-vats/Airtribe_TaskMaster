import type { Prisma, ProjectRole } from '@prisma/client';
import { prisma } from '../../db/prisma';

type Db = Prisma.TransactionClient;

/** Fields of a project list item, before `myRole` is attached. */
const projectSummarySelect = {
    id: true,
    name: true,
    description: true,
    createdAt: true,
    updatedAt: true,
    _count: { select: { members: true } },
} satisfies Prisma.ProjectSelect;

/** Summary plus the current OWNER (the one-owner index guarantees at most one row). */
const projectDetailSelect = {
    ...projectSummarySelect,
    members: {
        where: { role: 'OWNER' },
        take: 1,
        select: { user: { select: { id: true, name: true, email: true } } },
    },
} satisfies Prisma.ProjectSelect;

export type ProjectSummaryRow = Prisma.ProjectGetPayload<{ select: typeof projectSummarySelect }>;
export type ProjectDetailRow = Prisma.ProjectGetPayload<{ select: typeof projectDetailSelect }>;

export function findMembership(
    projectId: string,
    userId: string,
): Promise<{ role: ProjectRole } | null> {
    return prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { role: true },
    });
}

export function createProject(
    db: Db,
    data: { name: string; description?: string | null; createdById: string },
): Promise<{ id: string }> {
    return db.project.create({ data, select: { id: true } });
}

export async function addMember(
    db: Db,
    data: { projectId: string; userId: string; role: ProjectRole },
): Promise<void> {
    await db.projectMember.create({ data, select: { projectId: true } });
}

export function findProjectDetail(id: string, db: Db = prisma): Promise<ProjectDetailRow | null> {
    return db.project.findUnique({ where: { id }, select: projectDetailSelect });
}

/** One page of the user's projects, most recently updated first, with their role in each. */
export async function listProjectsForUser(
    userId: string,
    { skip, take }: { skip: number; take: number },
): Promise<{ rows: { role: ProjectRole; project: ProjectSummaryRow }[]; total: number }> {
    const where = { userId } satisfies Prisma.ProjectMemberWhereInput;
    const [rows, total] = await prisma.$transaction([
        prisma.projectMember.findMany({
            where,
            // projectId breaks ties so pages stay stable when timestamps collide.
            orderBy: [{ project: { updatedAt: 'desc' } }, { projectId: 'asc' }],
            skip,
            take,
            select: { role: true, project: { select: projectSummarySelect } },
        }),
        prisma.projectMember.count({ where }),
    ]);
    return { rows, total };
}

export function updateProject(
    id: string,
    data: { name?: string; description?: string | null },
): Promise<ProjectDetailRow> {
    return prisma.project.update({ where: { id }, data, select: projectDetailSelect });
}

export async function deleteProject(id: string): Promise<void> {
    await prisma.project.delete({ where: { id }, select: { id: true } });
}
