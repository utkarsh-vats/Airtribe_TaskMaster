import { Prisma, type InvitationStatus, type ProjectRole } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import {
    ConflictError,
    ForbiddenError,
    GoneError,
    NotFoundError,
    UnauthorizedError,
} from '../../lib/errors';
import { publish } from '../../lib/events';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../lib/pagination';
import * as usersRepository from '../users/users.repository';
import * as invitationsRepository from './invitations.repository';
import type { InvitationRow, MyInvitationRow } from './invitations.repository';
import type { CreateInvitationInput, ListInvitationsQuery } from './invitations.schemas';
import * as membersRepository from './members.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Actor {
    userId: string;
    role: ProjectRole;
}

/** Expiry is lazy: a PENDING row past expiresAt is reported as EXPIRED. */
function withEffectiveStatus<T extends { status: InvitationStatus; expiresAt: Date }>(
    row: T,
    now: Date,
): T {
    return row.status === 'PENDING' && row.expiresAt <= now ? { ...row, status: 'EXPIRED' } : row;
}

const pendingExists = () => new ConflictError('A pending invitation already exists for this email');

export async function createInvitation(
    projectId: string,
    actor: Actor,
    { email, role }: CreateInvitationInput,
): Promise<InvitationRow> {
    if (role === 'ADMIN' && actor.role !== 'OWNER') {
        throw new ForbiddenError('Only the project owner can invite admins');
    }
    if (await membersRepository.isMemberByEmail(projectId, email)) {
        throw new ConflictError('This user is already a member of the project');
    }

    const now = new Date();
    await invitationsRepository.expireStalePending(projectId, email, now);
    if (await invitationsRepository.hasLivePending(projectId, email, now)) {
        throw pendingExists();
    }

    let invitation: InvitationRow;
    try {
        invitation = await invitationsRepository.createInvitation({
            projectId,
            email,
            role,
            invitedById: actor.userId,
            expiresAt: new Date(now.getTime() + env.INVITATION_TTL_DAYS * DAY_MS),
        });
    } catch (err) {
        // A concurrent invite for the same email won the one-pending index.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw pendingExists();
        }
        throw err;
    }
    await publish('invitation.created', {
        projectId,
        invitationId: invitation.id,
        email,
        actorId: actor.userId,
    });
    return invitation;
}

export async function listProjectInvitations(
    projectId: string,
    query: ListInvitationsQuery,
): Promise<{ items: InvitationRow[]; meta: PageMeta }> {
    const now = new Date();
    const { rows, total } = await invitationsRepository.listProjectInvitations(
        projectId,
        { status: query.status, ...toSkipTake(query) },
        now,
    );
    return {
        items: rows.map((row) => withEffectiveStatus(row, now)),
        meta: buildPageMeta(total, query.page, query.limit),
    };
}

export async function revokeInvitation(projectId: string, invitationId: string): Promise<void> {
    const invitation = await invitationsRepository.findInvitation(invitationId, { projectId });
    if (!invitation) {
        throw new NotFoundError('Invitation');
    }
    const revoked = await invitationsRepository.resolvePending(invitationId, 'REVOKED', new Date());
    if (revoked !== 1) {
        throw new ConflictError('Only a pending, unexpired invitation can be revoked');
    }
}

async function currentUserEmail(userId: string): Promise<string> {
    const user = await usersRepository.findPublicUserById(userId);
    if (!user) {
        throw new UnauthorizedError();
    }
    return user.email;
}

export async function listMyInvitations(userId: string): Promise<MyInvitationRow[]> {
    return invitationsRepository.listLivePendingForEmail(
        await currentUserEmail(userId),
        new Date(),
    );
}

/**
 * Checks shared by accept and decline, in order: not mine → 404 (existence isn't revealed),
 * not PENDING → 409, expired → 410.
 */
async function loadRespondableInvitation(userId: string, invitationId: string, now: Date) {
    const email = await currentUserEmail(userId);
    const invitation = await invitationsRepository.findInvitation(invitationId);
    if (!invitation || invitation.email !== email) {
        throw new NotFoundError('Invitation');
    }
    if (invitation.status !== 'PENDING') {
        throw new ConflictError('This invitation is no longer pending');
    }
    if (invitation.expiresAt <= now) {
        throw new GoneError('This invitation has expired', 'INVITATION_EXPIRED');
    }
    return invitation;
}

const alreadyResolved = () => new ConflictError('This invitation is no longer pending');

export async function acceptInvitation(
    userId: string,
    invitationId: string,
): Promise<{ projectId: string; role: ProjectRole }> {
    const now = new Date();
    const { projectId, role } = await loadRespondableInvitation(userId, invitationId, now);

    if (await membersRepository.findMemberRole(projectId, userId)) {
        throw new ConflictError('You are already a member of this project');
    }

    await prisma.$transaction(async (tx) => {
        // Status guard: of two concurrent accepts, only one moves the row and adds the member.
        const accepted = await invitationsRepository.resolvePending(
            invitationId,
            'ACCEPTED',
            now,
            tx,
        );
        if (accepted !== 1) {
            throw alreadyResolved();
        }
        await membersRepository.addMember(tx, { projectId, userId, role });
    });
    return { projectId, role };
}

export async function declineInvitation(userId: string, invitationId: string): Promise<void> {
    const now = new Date();
    await loadRespondableInvitation(userId, invitationId, now);

    const declined = await invitationsRepository.resolvePending(invitationId, 'DECLINED', now);
    if (declined !== 1) {
        throw alreadyResolved();
    }
}
