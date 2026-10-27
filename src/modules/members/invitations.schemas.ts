import { InvitationStatus } from '@prisma/client';
import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination';
import { emailSchema, uuidParam } from '../../lib/schemas';

export const invitationIdParamsSchema = uuidParam('invitationId');

// OWNER can't be granted by invitation (also a CHECK constraint); ownership moves by transfer.
export const createInvitationBodySchema = z.strictObject({
    email: emailSchema,
    role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});

export const listInvitationsQuerySchema = paginationQuerySchema.extend({
    status: z.enum(InvitationStatus).optional(),
});

export type CreateInvitationInput = z.infer<typeof createInvitationBodySchema>;
export type ListInvitationsQuery = z.infer<typeof listInvitationsQuerySchema>;
