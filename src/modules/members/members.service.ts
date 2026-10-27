import type { ProjectRole } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors';
import * as membersRepository from './members.repository';
import type { MemberRow } from './members.repository';

/** The caller, as loaded by loadMembership. */
interface Actor {
    userId: string;
    role: ProjectRole;
}

export function listMembers(projectId: string): Promise<MemberRow[]> {
    return membersRepository.listMembers(projectId);
}

/**
 * OWNER-only (enforced by the route). `role: 'OWNER'` transfers ownership: the caller is
 * demoted to ADMIN first, because the one-owner partial unique index rejects two OWNER rows
 * even inside a transaction.
 */
export async function changeRole(
    projectId: string,
    actor: Actor,
    targetUserId: string,
    role: ProjectRole,
): Promise<MemberRow[]> {
    if (targetUserId === actor.userId) {
        throw new ConflictError('You cannot change your own role');
    }

    return prisma.$transaction(async (tx) => {
        const target = await membersRepository.findMemberRole(projectId, targetUserId, tx);
        if (!target) {
            throw new NotFoundError('Member');
        }

        if (role === 'OWNER') {
            const demoted = await membersRepository.changeRoleIf(
                tx,
                { projectId, userId: actor.userId, from: 'OWNER' },
                'ADMIN',
            );
            if (demoted !== 1) {
                // Someone else changed ownership since loadMembership ran.
                throw new ConflictError('You are no longer the project owner');
            }
        }

        await membersRepository.changeRoleIf(
            tx,
            { projectId, userId: targetUserId, from: target.role },
            role,
        );
        return membersRepository.listMembers(projectId, tx);
    });
}

/**
 * Leaving (target is the caller) or removing someone else. Either way the membership goes and
 * the user's open tasks in the project are unassigned, atomically.
 */
export async function removeMember(
    projectId: string,
    actor: Actor,
    targetUserId: string,
): Promise<void> {
    const leaving = targetUserId === actor.userId;

    if (leaving && actor.role === 'OWNER') {
        throw new ConflictError('Transfer ownership before leaving');
    }
    if (!leaving && actor.role === 'MEMBER') {
        throw new ForbiddenError();
    }

    await prisma.$transaction(async (tx) => {
        if (!leaving) {
            const target = await membersRepository.findMemberRole(projectId, targetUserId, tx);
            if (!target) {
                throw new NotFoundError('Member');
            }
            // OWNER removes ADMINs and MEMBERs; ADMIN removes MEMBERs only.
            const allowed =
                actor.role === 'OWNER' ? target.role !== 'OWNER' : target.role === 'MEMBER';
            if (!allowed) {
                throw new ForbiddenError();
            }
        }

        const deleted = await membersRepository.deleteMember(tx, projectId, targetUserId);
        if (deleted !== 1) {
            throw new NotFoundError('Member');
        }
        await membersRepository.unassignOpenTasks(tx, projectId, targetUserId);
    });
}
