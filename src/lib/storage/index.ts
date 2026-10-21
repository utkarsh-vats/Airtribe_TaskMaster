import { env } from '../../config/env';
import { logger } from '../logger';
import { LocalStorage } from './localStorage';
import type { StorageDriver } from './storage';

export type { StorageDriver } from './storage';

export const storage: StorageDriver = new LocalStorage(env.UPLOAD_DIR);

/**
 * Best-effort cleanup after a DB change has committed: a failed file delete is logged, never
 * thrown, so it can't fail a request whose data change already succeeded.
 */
export async function deleteStoredFiles(keys: string[]): Promise<void> {
    const results = await Promise.allSettled(keys.map((key) => storage.delete(key)));
    results.forEach((result, i) => {
        if (result.status === 'rejected') {
            logger.warn({ err: result.reason, key: keys[i] }, 'Failed to delete stored file');
        }
    });
}
