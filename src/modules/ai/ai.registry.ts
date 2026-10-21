import { env } from '../../config/env';
import type { AiProvider } from './ai.provider';
import { AnthropicProvider } from './providers/anthropic.provider';
import { GeminiProvider } from './providers/gemini.provider';

/** `undefined` = not overridden; `null` = overridden to "no provider". */
let override: AiProvider | null | undefined;
let configured: AiProvider | null | undefined;

function createConfiguredProvider(): AiProvider | null {
    // Tests must never reach a real API, even if a developer's .env sets a key.
    if (env.NODE_ENV === 'test') return null;
    const { AI_PROVIDER, AI_API_KEY, AI_MODEL } = env;
    // env.ts already requires the key and model whenever a provider is set.
    if (!AI_PROVIDER || !AI_API_KEY || !AI_MODEL) return null;
    switch (AI_PROVIDER) {
        case 'anthropic':
            return new AnthropicProvider(AI_API_KEY, AI_MODEL);
        case 'gemini':
            return new GeminiProvider(AI_API_KEY, AI_MODEL);
    }
}

/** The provider to use, or null when AI is disabled. Built lazily on first use. */
export function getAiProvider(): AiProvider | null {
    if (override !== undefined) return override;
    if (configured === undefined) configured = createConfiguredProvider();
    return configured;
}

/** Tests: force a provider (or `null` for "disabled"); `undefined` restores the configured one. */
export function setAiProvider(provider: AiProvider | null | undefined): void {
    override = provider;
}
