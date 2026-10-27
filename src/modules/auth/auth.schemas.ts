import { z } from 'zod';
import { emailSchema, passwordSchema } from '../../lib/schemas';

export const registerBodySchema = z.strictObject({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().trim().min(1).max(100),
});

// No length minimum on login: a short password is just wrong, not a validation error.
export const loginBodySchema = z.strictObject({
    email: emailSchema,
    password: z.string().min(1).max(128),
});

export const refreshTokenBodySchema = z.strictObject({
    refreshToken: z.string().min(1).max(512),
});

export type RegisterInput = z.infer<typeof registerBodySchema>;
export type LoginInput = z.infer<typeof loginBodySchema>;
