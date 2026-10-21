import { GoogleGenAI } from '@google/genai';
import { AI_TIMEOUT_MS, type AiProvider, type TaskDescriptionInput } from '../ai.provider';
import { buildTaskDescriptionPrompt, TASK_DESCRIPTION_SYSTEM_PROMPT } from '../ai.prompt';

/** Gemini via the official @google/genai SDK. The model comes from AI_MODEL. */
export class GeminiProvider implements AiProvider {
    readonly name = 'gemini';
    private readonly client: GoogleGenAI;

    constructor(
        apiKey: string,
        private readonly model: string,
    ) {
        this.client = new GoogleGenAI({ apiKey, httpOptions: { timeout: AI_TIMEOUT_MS } });
    }

    async generateTaskDescription(input: TaskDescriptionInput): Promise<string> {
        const response = await this.client.models.generateContent({
            model: this.model,
            contents: buildTaskDescriptionPrompt(input),
            config: {
                systemInstruction: TASK_DESCRIPTION_SYSTEM_PROMPT,
                // Belt and braces with httpOptions.timeout: abort the call outright.
                abortSignal: AbortSignal.timeout(AI_TIMEOUT_MS),
            },
        });

        const text = response.text;
        if (!text) {
            const reason = response.candidates?.[0]?.finishReason ?? 'unknown';
            throw new Error(`Gemini returned no text (finishReason: ${reason})`);
        }
        return text;
    }
}
