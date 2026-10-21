import { ProjectRole } from '@prisma/client';
import { z } from 'zod';
import { uuidParam } from '../../lib/schemas';

export const memberUserIdParamsSchema = uuidParam('userId');

/** `OWNER` means "transfer ownership to this member". */
export const updateMemberRoleBodySchema = z.strictObject({
    role: z.enum(ProjectRole),
});

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleBodySchema>;
