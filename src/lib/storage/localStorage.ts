import { createReadStream } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { StorageDriver } from './storage';

/** Files on local disk under `root`. Directories are created lazily on first write. */
export class LocalStorage implements StorageDriver {
    private readonly root: string;

    constructor(root: string) {
        this.root = path.resolve(root);
    }

    /** Absolute path for `key`; throws if it would land outside the root (path traversal). */
    private pathFor(key: string): string {
        const full = path.resolve(this.root, key);
        if (!full.startsWith(this.root + path.sep)) {
            throw new Error(`Storage key resolves outside the upload directory: ${key}`);
        }
        return full;
    }

    async put(key: string, data: Buffer): Promise<void> {
        const file = this.pathFor(key);
        await mkdir(path.dirname(file), { recursive: true });
        // 'wx' fails instead of overwriting, in case a key were ever reused.
        await writeFile(file, data, { flag: 'wx' });
    }

    get(key: string): Readable {
        return createReadStream(this.pathFor(key));
    }

    async delete(key: string): Promise<void> {
        await rm(this.pathFor(key), { force: true });
    }

    async exists(key: string): Promise<boolean> {
        try {
            await access(this.pathFor(key));
            return true;
        } catch {
            return false;
        }
    }
}
