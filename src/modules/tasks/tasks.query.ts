import { Prisma, TaskPriority, TaskStatus } from '@prisma/client';
import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination';
import { isoDateTimeSchema } from './tasks.schemas';

/** `OPEN,IN_PROGRESS` → ['OPEN', 'IN_PROGRESS'], each value checked against `item`. */
function commaList<S extends z.ZodType<unknown, string>>(item: S) {
    return z
        .string()
        .transform((value) => value.split(',').map((part) => part.trim()))
        .pipe(z.array(item).min(1));
}

const SORT_FIELDS = ['dueDate', 'createdAt', 'updatedAt', 'priority', 'title'] as const;
type SortField = (typeof SORT_FIELDS)[number];

/** Direction used when `order` is omitted: the "most useful first" order for each field. */
const DEFAULT_ORDER: Record<SortField, Prisma.SortOrder> = {
    dueDate: 'asc',
    createdAt: 'desc',
    updatedAt: 'desc',
    priority: 'desc', // URGENT first
    title: 'asc',
};

/** Shared by GET /projects/:projectId/tasks and GET /users/me/tasks. Unknown params → 422. */
export const taskListQuerySchema = z.strictObject({
    ...paginationQuerySchema.shape,
    status: commaList(z.enum(TaskStatus)).optional(),
    priority: commaList(z.enum(TaskPriority)).optional(),
    assignee: z.union([z.literal('me'), z.literal('unassigned'), z.uuid()]).optional(),
    createdBy: z.union([z.literal('me'), z.uuid()]).optional(),
    dueBefore: isoDateTimeSchema.optional(),
    dueAfter: isoDateTimeSchema.optional(),
    // Not z.coerce.boolean(): that turns the string "false" into true.
    overdue: z
        .enum(['true', 'false'])
        .transform((value) => value === 'true')
        .optional(),
    q: z.string().trim().min(1).max(200).optional(),
    sort: z.enum(SORT_FIELDS).default('createdAt'),
    order: z.enum(['asc', 'desc']).optional(),
});

/** /users/me/tasks is always "assigned to me", so `assignee` is rejected as unknown. */
export const myTasksQuerySchema = taskListQuerySchema.omit({ assignee: true });

export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
export type MyTasksQuery = z.infer<typeof myTasksQuerySchema>;

type TaskFilters = Omit<TaskListQuery, 'page' | 'limit' | 'sort' | 'order'>;

/** Filters from the query string. `me` resolves to `userId`; overdue compares against `now`. */
export function buildTaskWhere(
    filters: TaskFilters,
    { userId, now }: { userId: string; now: Date },
): Prisma.TaskWhereInput {
    const and: Prisma.TaskWhereInput[] = [];

    if (filters.status) and.push({ status: { in: filters.status } });
    if (filters.priority) and.push({ priority: { in: filters.priority } });

    if (filters.assignee === 'me') and.push({ assigneeId: userId });
    else if (filters.assignee === 'unassigned') and.push({ assigneeId: null });
    else if (filters.assignee) and.push({ assigneeId: filters.assignee });

    if (filters.createdBy) {
        and.push({ createdById: filters.createdBy === 'me' ? userId : filters.createdBy });
    }

    if (filters.dueBefore) and.push({ dueDate: { lt: filters.dueBefore } });
    if (filters.dueAfter) and.push({ dueDate: { gt: filters.dueAfter } });

    if (filters.overdue === true) {
        and.push({ dueDate: { lt: now }, status: { not: 'COMPLETED' } });
    } else if (filters.overdue === false) {
        and.push({
            OR: [{ dueDate: null }, { dueDate: { gte: now } }, { status: 'COMPLETED' }],
        });
    }

    if (filters.q) {
        // `contains` + insensitive compiles to ILIKE '%q%', which the trigram indexes cover.
        and.push({
            OR: [
                { title: { contains: filters.q, mode: 'insensitive' } },
                { description: { contains: filters.q, mode: 'insensitive' } },
            ],
        });
    }

    return { AND: and };
}

/** Whitelisted sort with per-field default direction; dueDate nulls last; id breaks ties. */
export function buildTaskOrderBy({
    sort,
    order,
}: Pick<TaskListQuery, 'sort' | 'order'>): Prisma.TaskOrderByWithRelationInput[] {
    const direction = order ?? DEFAULT_ORDER[sort];

    let primary: Prisma.TaskOrderByWithRelationInput;
    switch (sort) {
        case 'dueDate':
            primary = { dueDate: { sort: direction, nulls: 'last' } };
            break;
        case 'createdAt':
            primary = { createdAt: direction };
            break;
        case 'updatedAt':
            primary = { updatedAt: direction };
            break;
        case 'priority':
            primary = { priority: direction };
            break;
        case 'title':
            primary = { title: direction };
            break;
    }

    return [primary, { id: 'asc' }];
}
