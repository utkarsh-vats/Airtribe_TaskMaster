import type { Prisma } from '@prisma/client';

/** The only user fields that may leave the service layer. Never add `passwordHash`. */
export const publicUserSelect = {
    id: true,
    email: true,
    name: true,
    bio: true,
    avatarUrl: true,
    createdAt: true,
    updatedAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;
