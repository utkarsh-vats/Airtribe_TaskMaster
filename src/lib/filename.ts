const MAX_LENGTH = 255;

/**
 * A display-safe version of a client-supplied filename: last path segment only (either slash),
 * no control characters, at most 255 characters, "file" if nothing usable is left. Only ever
 * stored as `original_name`; it never becomes part of a storage path.
 */
export function sanitizeFilename(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? '';
    // eslint-disable-next-line no-control-regex
    const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    // Array.from splits by code point, so a cut never leaves half a surrogate pair.
    const truncated = Array.from(cleaned).slice(0, MAX_LENGTH).join('');
    return truncated === '' || truncated === '.' || truncated === '..' ? 'file' : truncated;
}
