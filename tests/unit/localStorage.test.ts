import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorage } from '../../src/lib/storage/localStorage';

let root: string;
let storage: LocalStorage;

beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'taskmaster-storage-'));
    // A nested, not-yet-existing root: directories must be created lazily.
    storage = new LocalStorage(path.join(root, 'uploads'));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('LocalStorage', () => {
    it('puts, reads, checks and deletes a file', async () => {
        await storage.put('project-1/abc', Buffer.from('hello'));

        expect(await storage.exists('project-1/abc')).toBe(true);
        expect(await text(storage.get('project-1/abc'))).toBe('hello');
        expect(await readFile(path.join(root, 'uploads', 'project-1', 'abc'), 'utf8')).toBe(
            'hello',
        );

        await storage.delete('project-1/abc');
        expect(await storage.exists('project-1/abc')).toBe(false);
    });

    it('does not error when deleting a file that is already gone', async () => {
        await expect(storage.delete('project-1/never-existed')).resolves.toBeUndefined();
    });

    it('refuses to overwrite an existing key', async () => {
        await storage.put('project-1/once', Buffer.from('a'));

        await expect(storage.put('project-1/once', Buffer.from('b'))).rejects.toThrow();
    });

    it.each([
        ['a parent-directory escape', '../outside.txt'],
        ['a nested escape', 'project-1/../../outside.txt'],
        // Built from tmpdir(), not `root`: it.each runs before beforeAll assigns root.
        ['an absolute path', path.join(tmpdir(), 'outside.txt')],
        ['the root itself', '.'],
    ])('refuses %s', async (_label, key) => {
        await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow(/outside the upload/);
        await expect(storage.exists(key)).resolves.toBe(false);
        await expect(storage.delete(key)).rejects.toThrow(/outside the upload/);
        expect(() => storage.get(key)).toThrow(/outside the upload/);
    });
});
