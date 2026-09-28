import type {ClaudeToolOptions, ClaudeToolsResult} from './claude-tools';
import {createClaudeTools} from './claude-tools';

/**
 * OpenAI now uses the same TanStack tool registry as Claude to keep
 * schema/behavior parity across providers.
 */
export async function createOpenAITools(options: ClaudeToolOptions): Promise<ClaudeToolsResult> {
	return await createClaudeTools(options);
}
