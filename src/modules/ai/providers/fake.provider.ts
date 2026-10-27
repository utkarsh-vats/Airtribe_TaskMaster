import type { AiProvider, TaskDescriptionInput } from '../ai.provider';

/** Deterministic stand-in for tests: the output is built only from the input. */
export class FakeAiProvider implements AiProvider {
    readonly name = 'fake';
    readonly calls: TaskDescriptionInput[] = [];

    async generateTaskDescription(input: TaskDescriptionInput): Promise<string> {
        this.calls.push(input);
        return [
            `  Goal: deliver "${input.title}".`,
            '- The work described in the title is complete',
            input.notes ? `- Notes addressed: ${input.notes}` : '- No extra notes',
            '- Changes are reviewed and tested  ',
        ].join('\n');
    }
}
