import { AiDisabledError, AiUpstreamError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { getAiProvider } from './ai.registry';
import type { TaskDescriptionBody } from './ai.schemas';

/** Same limit as a task's description, so the suggestion can be saved as-is. */
export const MAX_DESCRIPTION_LENGTH = 5000;

/** Trimmed and capped at the task description limit, without splitting a surrogate pair. */
export function finalizeDescription(raw: string): string {
    let text = raw.trim().slice(0, MAX_DESCRIPTION_LENGTH);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return text.trimEnd();
}

/**
 * Suggests a description; it never creates or changes a task. 503 when no provider is
 * configured; 502 on any provider failure, timeout or empty answer (details are logged only).
 */
export async function suggestTaskDescription({
    title,
    notes,
}: TaskDescriptionBody): Promise<string> {
    const provider = getAiProvider();
    if (!provider) {
        throw new AiDisabledError();
    }

    let raw: string;
    try {
        raw = await provider.generateTaskDescription({ title, ...(notes ? { notes } : {}) });
    } catch (err) {
        logger.error({ err, provider: provider.name }, 'AI provider request failed');
        throw new AiUpstreamError();
    }

    const description = finalizeDescription(raw);
    if (description === '') {
        logger.error({ provider: provider.name }, 'AI provider returned an empty description');
        throw new AiUpstreamError();
    }
    return description;
}
