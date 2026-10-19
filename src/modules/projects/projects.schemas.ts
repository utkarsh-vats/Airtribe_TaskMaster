import { z } from 'zod';
import { uuidParam } from '../../lib/schemas';

export const projectIdParamsSchema = uuidParam('projectId');

const nameSchema = z.string().trim().min(1).max(100);
const descriptionSchema = z.string().max(5000).nullable();

export const createProjectBodySchema = z.strictObject({
    name: nameSchema,
    description: descriptionSchema.optional(),
});

export const updateProjectBodySchema = z
    .strictObject({
        name: nameSchema.optional(),
        description: descriptionSchema.optional(),
    })
    .refine((body) => Object.keys(body).length > 0, {
        message: 'Provide at least one of name, description',
    });

export type CreateProjectInput = z.infer<typeof createProjectBodySchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectBodySchema>;
