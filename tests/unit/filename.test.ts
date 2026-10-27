import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../../src/lib/filename';

describe('sanitizeFilename', () => {
    it.each([
        ['report.pdf', 'report.pdf'],
        ['../../evil.txt', 'evil.txt'],
        ['..\\..\\windows\\evil.txt', 'evil.txt'],
        ['/etc/passwd', 'passwd'],
        ['bad\u0000na\u001fme\u007f.txt', 'badname.txt'],
        ['  spaced.txt  ', 'spaced.txt'],
        ['résumé.pdf', 'résumé.pdf'],
        ['', 'file'],
        ['..', 'file'],
        ['dir/', 'file'],
        ['\u0001\u0002', 'file'],
    ])('%j → %j', (input, expected) => {
        expect(sanitizeFilename(input)).toBe(expected);
    });

    it('truncates to 255 characters without splitting a surrogate pair', () => {
        const long = `${'a'.repeat(254)}😀😀.txt`;

        const result = sanitizeFilename(long);

        expect(Array.from(result)).toHaveLength(255);
        expect(result.endsWith('😀')).toBe(true);
    });
});
