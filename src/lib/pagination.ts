import { z } from 'zod';

export const MAX_PAGE_LIMIT = 100;

/** `?page=&limit=` — query strings are coerced to numbers. Extend it for list endpoints. */
export const paginationQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface PageMeta {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

/** Prisma `skip`/`take` for a page. */
export function toSkipTake({ page, limit }: PaginationQuery): { skip: number; take: number } {
    return { skip: (page - 1) * limit, take: limit };
}

export function buildPageMeta(total: number, page: number, limit: number): PageMeta {
    return { page, limit, total, totalPages: Math.ceil(total / limit) };
}
