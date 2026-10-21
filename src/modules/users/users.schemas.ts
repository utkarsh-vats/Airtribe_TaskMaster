import { z } from 'zod';
import { passwordSchema } from '../../lib/schemas';

export const updateMeBodySchema = z
    .strictObject({
        name: z.string().trim().min(1).max(100).optional(),
        bio: z.string().max(500).nullable().optional(),
        avatarUrl: z
            .url({ protocol: /^https?$/, message: 'Must be an http(s) URL' })
            .max(2048)
            .nullable()
            .optional(),
    })
    .refine((body) => Object.keys(body).length > 0, {
        message: 'Provide at least one of name, bio, avatarUrl',
    });

export const changePasswordBodySchema = z
    .strictObject({
        // Only checked against the stored hash; the length cap bounds argon2 work.
        currentPassword: z.string().min(1).max(128),
        newPassword: passwordSchema,
    })
    .refine((body) => body.newPassword !== body.currentPassword, {
        message: 'New password must be different from the current password',
        path: ['newPassword'],
    });

export type UpdateMeInput = z.infer<typeof updateMeBodySchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordBodySchema>;
