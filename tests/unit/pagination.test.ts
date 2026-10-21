import { describe, expect, it } from 'vitest';
import { buildPageMeta, paginationQuerySchema, toSkipTake } from '../../src/lib/pagination';

describe('paginationQuerySchema', () => {
    it('defaults to page 1, limit 20', () => {
        expect(paginationQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    });

    it('coerces query-string values to numbers', () => {
        expect(paginationQuerySchema.parse({ page: '3', limit: '50' })).toEqual({
            page: 3,
            limit: 50,
        });
    });

    it('accepts the bounds', () => {
        expect(paginationQuerySchema.parse({ page: '1', limit: '1' })).toEqual({
            page: 1,
            limit: 1,
        });
        expect(paginationQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    });

    it.each([
        ['page 0', { page: '0' }],
        ['negative page', { page: '-1' }],
        ['fractional page', { page: '1.5' }],
        ['non-numeric page', { page: 'abc' }],
        ['limit 0', { limit: '0' }],
        ['limit over 100', { limit: '101' }],
        ['non-numeric limit', { limit: 'ten' }],
    ])('rejects %s', (_label, input) => {
        expect(paginationQuerySchema.safeParse(input).success).toBe(false);
    });
});

describe('toSkipTake', () => {
    it('starts at 0 for the first page', () => {
        expect(toSkipTake({ page: 1, limit: 20 })).toEqual({ skip: 0, take: 20 });
    });

    it('skips the previous pages', () => {
        expect(toSkipTake({ page: 3, limit: 25 })).toEqual({ skip: 50, take: 25 });
    });
});

describe('buildPageMeta', () => {
    it('rounds totalPages up for a partial last page', () => {
        expect(buildPageMeta(57, 1, 20)).toEqual({ page: 1, limit: 20, total: 57, totalPages: 3 });
    });

    it('has an exact page count when total divides evenly', () => {
        expect(buildPageMeta(40, 2, 20).totalPages).toBe(2);
    });

    it('reports 0 pages when there are no items', () => {
        expect(buildPageMeta(0, 1, 20)).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
    });

    it('keeps the requested page even past the end', () => {
        expect(buildPageMeta(5, 4, 20)).toEqual({ page: 4, limit: 20, total: 5, totalPages: 1 });
    });
});
