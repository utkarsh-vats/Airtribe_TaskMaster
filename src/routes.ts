import { Router } from 'express';
import { authRouter } from './modules/auth/auth.routes';
import { invitationsRouter, projectInvitationsRouter } from './modules/members/invitations.routes';
import { membersRouter } from './modules/members/members.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { projectScopedRouter, projectsRouter } from './modules/projects/projects.routes';
import { tasksRouter } from './modules/tasks/tasks.routes';
import { attachmentsRouter } from './modules/attachments/attachments.routes';
import { commentsRouter } from './modules/comments/comments.routes';
import { usersRouter } from './modules/users/users.routes';

/**
 * Every feature router is mounted here under /api/v1.
 * Project sub-resources attach to `projectScopedRouter`, which already runs authenticate →
 * validate(projectId) → loadMembership.
 */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/projects', projectsRouter);
apiRouter.use('/invitations', invitationsRouter);
apiRouter.use('/notifications', notificationsRouter);

projectScopedRouter.use('/members', membersRouter);
projectScopedRouter.use('/invitations', projectInvitationsRouter);
projectScopedRouter.use('/tasks', tasksRouter);
projectScopedRouter.use('/comments', commentsRouter);
projectScopedRouter.use('/attachments', attachmentsRouter);
