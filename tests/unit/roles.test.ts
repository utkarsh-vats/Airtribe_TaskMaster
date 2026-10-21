import { describe, expect, it } from 'vitest';
import { hasRole } from '../../src/lib/roles';

describe('hasRole', () => {
    it.each([
        ['OWNER', 'OWNER', true],
        ['OWNER', 'ADMIN', true],
        ['OWNER', 'MEMBER', true],
        ['ADMIN', 'OWNER', false],
        ['ADMIN', 'ADMIN', true],
        ['ADMIN', 'MEMBER', true],
        ['MEMBER', 'OWNER', false],
        ['MEMBER', 'ADMIN', false],
        ['MEMBER', 'MEMBER', true],
    ] as const)('%s meets %s: %s', (role, min, expected) => {
        expect(hasRole(role, min)).toBe(expected);
    });
});
