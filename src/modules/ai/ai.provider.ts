export interface TaskDescriptionInput {
    title: string;
    notes?: string;
}

/** Something that can draft a task description. Real ones call an LLM; tests use a fake. */
export interface AiProvider {
    /** For logs only, e.g. "anthropic". */
    readonly name: string;
    /** Raw model output; the service trims and caps it. Throws on any provider failure. */
    generateTaskDescription(input: TaskDescriptionInput): Promise<string>;
}

/** Hard ceiling for one provider call, retries included (the SDKs are set to not retry). */
export const AI_TIMEOUT_MS = 10_000;
