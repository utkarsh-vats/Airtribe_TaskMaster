import Anthropic from '@anthropic-ai/sdk';
import { AI_TIMEOUT_MS, type AiProvider, type TaskDescriptionInput } from '../ai.provider';
import { buildTaskDescriptionPrompt, TASK_DESCRIPTION_SYSTEM_PROMPT } from '../ai.prompt';

/** Claude via the official SDK. The model comes from AI_MODEL. */
export class AnthropicProvider implements AiProvider {
    readonly name = 'anthropic';
    private readonly client: Anthropic;

    constructor(
        apiKey: string,
        private readonly model: string,
    ) {
        // No retries, so AI_TIMEOUT_MS is the whole budget (the SDK retries timeouts otherwise).
        this.client = new Anthropic({ apiKey, timeout: AI_TIMEOUT_MS, maxRetries: 0 });
    }

    async generateTaskDescription(input: TaskDescriptionInput): Promise<string> {
        const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 16000,
            system: TASK_DESCRIPTION_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: buildTaskDescriptionPrompt(input) }],
        });

        if (response.stop_reason === 'refusal') {
            throw new Error('The model declined to write a description');
        }
        return response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');
    }
}
