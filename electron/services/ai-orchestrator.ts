import type {AttachmentMeta, AttachmentService} from './attachment-service';
import type {ChatService} from './chat-service';
import type {ClaudeService} from './claude-service';
import type {DatabaseService} from './database-service';
import type {GitHubService} from './github-service';
import {LATENCY_FLAGS} from './latency-flags';
import type {OpenAIService} from './openai-service';
import type {SchemaIndexService} from './schema-index-service';
import type {SpyCodeAiMcpService} from './spy-code-ai-mcp-service';
import type {AiQualityProfile} from './settings-service';

type DebugLog = (type: 'query' | 'tool' | 'api' | 'error' | 'info', category: string, message: string, details?: string) => void;

export interface OrchestratorInput {
	chatId: string;
	userMessage: string;
	databaseIds: string[];
	databaseService: DatabaseService;
	githubService: GitHubService;
	schemaIndexService: SchemaIndexService;
	spyCodeAiMcpService: SpyCodeAiMcpService;
	chatService: ChatService;
	attachmentService: AttachmentService;
	onProgress?: (status: string) => void;
	conversationHistory?: Array<{ role: string; content: string }>;
	databaseName?: string;
	dbHostOverride?: string;
	githubBranchOverride?: string;
	attachments?: AttachmentMeta[];
	aiQualityProfile?: AiQualityProfile;
	onDebugLog?: DebugLog;
	onEvent?: (event: unknown) => void;
	abortController?: AbortController;
}

export class AIOrchestrator {
	constructor(
		private readonly claudeService: ClaudeService,
		private readonly openaiService: OpenAIService,
	) {
	}

	async sendMessage(provider: 'claude' | 'openai', input: OrchestratorInput): Promise<any> {
		if (LATENCY_FLAGS.useUnifiedOrchestrator) {
			input.onDebugLog?.('info', 'Orchestrator', `Unified orchestrator active for provider: ${provider}`);
		}
		if (provider === 'openai') {
			return await this.openaiService.sendMessage(
				input.chatId,
				input.userMessage,
				input.databaseIds,
				input.databaseService,
				input.githubService,
				input.schemaIndexService,
				input.spyCodeAiMcpService,
				input.chatService,
				input.attachmentService,
				input.onProgress,
				input.conversationHistory,
				input.databaseName,
				input.dbHostOverride,
				input.githubBranchOverride,
				input.attachments,
				input.aiQualityProfile,
				input.onDebugLog,
				input.onEvent,
				input.abortController,
			);
		}
		return await this.claudeService.sendMessage(
			input.chatId,
			input.userMessage,
			input.databaseIds,
			input.databaseService,
			input.githubService,
			input.schemaIndexService,
			input.spyCodeAiMcpService,
			input.chatService,
			input.attachmentService,
			input.onProgress,
			input.conversationHistory,
			input.databaseName,
			input.dbHostOverride,
			input.githubBranchOverride,
			input.attachments,
			input.aiQualityProfile,
			input.onDebugLog,
			input.onEvent,
			input.abortController,
		);
	}
}
