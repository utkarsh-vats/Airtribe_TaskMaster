import { z } from 'zod';

export const taskDescriptionBodySchema = z.strictObject({
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(2000).optional(),
});

export type TaskDescriptionBody = z.infer<typeof taskDescriptionBodySchema>;
