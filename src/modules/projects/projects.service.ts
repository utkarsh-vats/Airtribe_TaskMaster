import type { ProjectRole } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { NotFoundError } from '../../lib/errors';
import {
    buildPageMeta,
    toSkipTake,
    type PageMeta,
    type PaginationQuery,
} from '../../lib/pagination';
import { deleteStoredFiles } from '../../lib/storage';
import * as projectsRepository from './projects.repository';
import type { ProjectDetailRow, ProjectSummaryRow } from './projects.repository';
import type { CreateProjectInput, UpdateProjectInput } from './projects.schemas';

export interface ProjectSummary {
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    myRole: ProjectRole;
    memberCount: number;
}

export interface ProjectDetail extends ProjectSummary {
    owner: { id: string; name: string; email: string } | null;
}

function toSummary({ _count, ...project }: ProjectSummaryRow, myRole: ProjectRole): ProjectSummary {
    return { ...project, myRole, memberCount: _count.members };
}

function toDetail({ members, ...row }: ProjectDetailRow, myRole: ProjectRole): ProjectDetail {
    return { ...toSummary(row, myRole), owner: members[0]?.user ?? null };
}

/** Creates the project and the creator's OWNER membership atomically. */
export async function createProject(
    userId: string,
    { name, description }: CreateProjectInput,
): Promise<ProjectDetail> {
    const row = await prisma.$transaction(async (tx) => {
        const { id } = await projectsRepository.createProject(tx, {
            name,
            description,
            createdById: userId,
        });
        await projectsRepository.addMember(tx, { projectId: id, userId, role: 'OWNER' });
        return projectsRepository.findProjectDetail(id, tx);
    });
    if (!row) {
        throw new Error('Project vanished inside its own create transaction');
    }
    return toDetail(row, 'OWNER');
}

export async function listMyProjects(
    userId: string,
    query: PaginationQuery,
): Promise<{ items: ProjectSummary[]; meta: PageMeta }> {
    const { rows, total } = await projectsRepository.listProjectsForUser(userId, toSkipTake(query));
    return {
        items: rows.map(({ role, project }) => toSummary(project, role)),
        meta: buildPageMeta(total, query.page, query.limit),
    };
}

export async function getProject(projectId: string, myRole: ProjectRole): Promise<ProjectDetail> {
    // loadMembership already proved access; null only if it was deleted in between.
    const row = await projectsRepository.findProjectDetail(projectId);
    if (!row) {
        throw new NotFoundError('Project');
    }
    return toDetail(row, myRole);
}

export async function updateProject(
    projectId: string,
    myRole: ProjectRole,
    input: UpdateProjectInput,
): Promise<ProjectDetail> {
    return toDetail(await projectsRepository.updateProject(projectId, input), myRole);
}

export async function deleteProject(projectId: string): Promise<void> {
    // Members, invitations, tasks, comments and attachment rows go with it via ON DELETE CASCADE.
    const storageKeys = await projectsRepository.deleteProjectReturningStorageKeys(projectId);
    // After commit, and best-effort: a leftover file must not fail a delete that succeeded.
    await deleteStoredFiles(storageKeys);
}
