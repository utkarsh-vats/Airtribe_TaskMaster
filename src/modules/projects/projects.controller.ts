import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../../lib/http';
import { paginationQuerySchema } from '../../lib/pagination';
import { currentUserId } from '../../middleware/authenticate';
import { currentMembership } from '../../middleware/requireRole';
import { getValidated } from '../../middleware/validate';
import { createProjectBodySchema, updateProjectBodySchema } from './projects.schemas';
import * as projectsService from './projects.service';

export async function createProject(req: Request, res: Response): Promise<void> {
    const body = getValidated(req, 'body', createProjectBodySchema);
    created(res, await projectsService.createProject(currentUserId(req), body));
}

export async function listMyProjects(req: Request, res: Response): Promise<void> {
    const query = getValidated(req, 'query', paginationQuerySchema);
    const { items, meta } = await projectsService.listMyProjects(currentUserId(req), query);
    paginated(res, items, meta);
}

export async function getProject(req: Request, res: Response): Promise<void> {
    const { projectId, role } = currentMembership(req);
    ok(res, await projectsService.getProject(projectId, role));
}

export async function updateProject(req: Request, res: Response): Promise<void> {
    const { projectId, role } = currentMembership(req);
    const body = getValidated(req, 'body', updateProjectBodySchema);
    ok(res, await projectsService.updateProject(projectId, role, body));
}

export async function deleteProject(req: Request, res: Response): Promise<void> {
    await projectsService.deleteProject(currentMembership(req).projectId);
    noContent(res);
}
