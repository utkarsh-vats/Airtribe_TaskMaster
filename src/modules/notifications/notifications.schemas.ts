import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination';
import { uuidParam } from '../../lib/schemas';

export const notificationIdParamsSchema = uuidParam('notificationId');

export const listNotificationsQuerySchema = z.strictObject({
    ...paginationQuerySchema.shape,
    // Not z.coerce.boolean(): that turns the string "false" into true.
    unread: z
        .enum(['true', 'false'])
        .transform((value) => value === 'true')
        .optional(),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
