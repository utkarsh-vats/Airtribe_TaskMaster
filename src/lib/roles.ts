import type { ProjectRole } from '@prisma/client';

const ROLE_RANK: Record<ProjectRole, number> = {
    OWNER: 3,
    ADMIN: 2,
    MEMBER: 1,
};

/** True when `role` is at least `min` (OWNER > ADMIN > MEMBER). */
export function hasRole(role: ProjectRole, min: ProjectRole): boolean {
    return ROLE_RANK[role] >= ROLE_RANK[min];
}
