export async function createOpenAIProvider(apiKey: string): Promise<{
	createAdapter: (model: string) => unknown;
}> {
	const openAiModule     = await import('@tanstack/ai-openai');
	// TanStack exports createOpenaiChat (lowercase "ai") in current versions.
	const createOpenAIChat = (openAiModule as any).createOpenaiChat || (openAiModule as any).createOpenAIChat;
	if (typeof createOpenAIChat !== 'function') {
		throw new Error('TanStack OpenAI adapter is unavailable: createOpenaiChat not found');
	}
	return {
		createAdapter: (model: string) => createOpenAIChat(model, apiKey),
	};
}
