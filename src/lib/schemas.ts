import { z } from 'zod';

/** Route params object with one UUID param, e.g. `uuidParam('projectId')`. */
export function uuidParam<K extends string>(name: K) {
    // A computed key widens to `string`; the cast restores the literal key for inference.
    const shape = { [name]: z.uuid() } as Record<K, z.ZodUUID>;
    return z.object(shape);
}

/** Trimmed and lowercased before validation, so lookups and the unique index agree. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const passwordSchema = z.string().min(8).max(128);
