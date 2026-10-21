import type { Readable } from 'node:stream';

/**
 * Where attachment bytes live. Keys are generated server-side (`<projectId>/<uuid>`) and never
 * contain user input. LocalStorage is the only implementation; S3 would be another.
 */
export interface StorageDriver {
    put(key: string, data: Buffer): Promise<void>;
    /** Errors (e.g. ENOENT) surface on the stream, so check `exists` first for a clean 404. */
    get(key: string): Readable;
    /** No error if the file is already gone. */
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
}
