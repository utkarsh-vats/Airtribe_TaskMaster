import { TaskPriority, TaskStatus } from '@prisma/client';
import { z } from 'zod';
import { uuidParam } from '../../lib/schemas';

export const taskIdParamsSchema = uuidParam('taskId');

/** ISO 8601 with an explicit offset (`Z` or `+05:30`), so the instant is unambiguous. */
export const isoDateTimeSchema = z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value));

const titleSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().max(5000).nullable();
const dueDateSchema = isoDateTimeSchema.nullable();
const assigneeIdSchema = z.uuid().nullable();

// No status on create: every task starts OPEN.
export const createTaskBodySchema = z.strictObject({
    title: titleSchema,
    description: descriptionSchema.optional(),
    dueDate: dueDateSchema.optional(),
    priority: z.enum(TaskPriority).default('MEDIUM'),
    assigneeId: assigneeIdSchema.optional(),
});

export const updateTaskBodySchema = z
    .strictObject({
        title: titleSchema.optional(),
        description: descriptionSchema.optional(),
        dueDate: dueDateSchema.optional(),
        priority: z.enum(TaskPriority).optional(),
        status: z.enum(TaskStatus).optional(),
        assigneeId: assigneeIdSchema.optional(),
    })
    .refine((body) => Object.keys(body).length > 0, {
        message:
            'Provide at least one of title, description, dueDate, priority, status, assigneeId',
    });

export type CreateTaskInput = z.infer<typeof createTaskBodySchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskBodySchema>;
