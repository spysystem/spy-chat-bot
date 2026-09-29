import Anthropic from '@anthropic-ai/sdk';
import type {AttachmentMeta, AttachmentService} from './attachment-service';
import type {ChatService} from './chat-service';
import type {AgentToolset, DebugLogFn, EvidenceItem, ToolRunResult} from './claude-tools';
import {createAgentTools} from './claude-tools';
import type {DatabaseService} from './database-service';
import type {GitHubService} from './github-service';
import {KnowledgeService} from './knowledge-service';
import type {SchemaIndexService} from './schema-index-service';
import {SecureStorageService} from './secure-storage-service';
import type {SentryService} from './sentry-service';
import type {AiQualityProfile} from './settings-service';
import {loadPromptAsset} from './shared/prompt-asset-loader';
import type {SpyCodeAiMcpService} from './spy-code-ai-mcp-service';

const MAIN_MODEL         = 'claude-opus-5';
const LIGHT_MODEL        = 'claude-haiku-4-5';
const MAX_AGENT_TURNS    = 40;
const MAX_OUTPUT_TOKENS  = 64_000;
const MAX_HISTORY_ITEMS  = 40;
const MAX_HISTORY_CHARS  = 20_000;
const FALLBACK_BETA      = 'server-side-fallback-2026-07-01';
const SPY_CODE_AI_PROMPT = 'spy-code-ai-chatbot.mdc';

const EFFORT_BY_PROFILE: Record<AiQualityProfile, 'medium' | 'high'> = {
	balanced        : 'medium',
	maximum_accuracy: 'high',
};

export interface ClaudeServiceDeps {
	databaseService: DatabaseService;
	githubService: GitHubService;
	schemaIndexService: SchemaIndexService;
	spyCodeAiMcpService: SpyCodeAiMcpService;
	chatService: ChatService;
	attachmentService: AttachmentService;
	sentryService: SentryService;
}

export interface SendMessageInput {
	chatId: string;
	userMessage: string;
	databaseIds: string[];
	conversationHistory?: Array<{ role: string; content: string }>;
	databaseName?: string;
	dbHostOverride?: string;
	githubBranchOverride?: string;
	attachments?: AttachmentMeta[];
	qualityProfile?: AiQualityProfile;
	onProgress?: (status: string) => void;
	onDebugLog?: DebugLogFn;
	onEvent?: (event: Record<string, unknown>) => void;
	signal?: AbortSignal;
}

export type SendMessageResult =
	| { shortAnswer: string; detailedAnswer: string; suggestedTitle?: string }
	| { needsClarification: true; question: string; options?: string[]; allowFreeText: boolean };

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

export class ClaudeService {
	private readonly secureStorage: SecureStorageService;
	private readonly knowledgeService                              = new KnowledgeService();
	private readonly pendingSummaries                              = new Map<string, Promise<void>>();
	private deps: ClaudeServiceDeps | null                         = null;
	private client: { apiKey: string; instance: Anthropic } | null = null;

	constructor(secureStorage: SecureStorageService) {
		this.secureStorage = secureStorage;
		void this.knowledgeService.ensureLoaded().catch((error) => console.error('[ClaudeService] Knowledge base failed to load:', error));
	}

	setDependencies(deps: ClaudeServiceDeps): void {
		this.deps = deps;
	}

	async getApiKey(): Promise<string | null> {
		const key = await this.secureStorage.loadEncrypted('claude-api-key');
		return key ? key.trim() : null;
	}

	async saveApiKey(apiKey: string): Promise<void> {
		const trimmedKey = apiKey.trim();
		if (!trimmedKey.startsWith('sk-ant-')) {
			throw new Error('Invalid API key format. Must start with "sk-ant-"');
		}
		await this.secureStorage.saveEncrypted('claude-api-key', trimmedKey);
		this.client = null;
	}

	private async getClient(): Promise<Anthropic> {
		const apiKey = await this.getApiKey();
		if (!apiKey) {
			throw new Error('Claude API key not configured. Add it in Settings.');
		}
		if (!this.client || this.client.apiKey !== apiKey) {
			this.client = {apiKey, instance: new Anthropic({apiKey, maxRetries: 3})};
		}
		return this.client.instance;
	}

	async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
		if (!this.deps) {
			throw new Error('ClaudeService dependencies are not set');
		}
		const {databaseService, githubService, schemaIndexService, spyCodeAiMcpService, chatService, attachmentService, sentryService} = this.deps;
		const {chatId, userMessage, onProgress, onDebugLog, onEvent, signal}                                                           = input;
		const log                                                                                                                      = onDebugLog ?? (() => undefined);
		const client                                                                                                                   = await this.getClient();
		const effort                                                                                                                   = EFFORT_BY_PROFILE[input.qualityProfile ?? 'maximum_accuracy'];
		const evidence: EvidenceItem[]                                                                                                 = [];

		// The previous turn's working summary may still be being written.
		await this.pendingSummaries.get(chatId)?.catch(() => undefined);

		onProgress?.('Preparing...');
		const chatRecord = await chatService.getChat(chatId);
		const branch     = await githubService.resolveBranch(input.githubBranchOverride);
		const toolset    = await createAgentTools({
			databaseService,
			githubService,
			schemaIndexService,
			spyCodeAiMcpService,
			sentryService,
			knowledgeService: this.knowledgeService,
			systemKey       : chatRecord?.systemKey?.trim() || undefined,
			databaseIds     : input.databaseIds,
			databaseName    : input.databaseName,
			dbHostOverride  : input.dbHostOverride,
			branch,
			onProgress,
			onDebugLog,
			evidence,
		});
		const toolByName = new Map(toolset.tools.map((t) => [t.definition.name, t]));

		const workingSummary = chatRecord?.workingSummary?.text?.trim() || '';
		const knowledgeDocs  = await this.knowledgeService.search(userMessage, 4).catch(() => []);
		const system         = await this.buildSystemPrompt({
			toolset,
			databaseName: input.databaseName,
			dbHost      : input.dbHostOverride,
			databaseIds : input.databaseIds,
			branch,
			systemName  : chatRecord?.systemName,
			systemKey   : chatRecord?.systemKey,
			systemUrl   : chatRecord?.systemUrl,
			workingSummary,
			knowledge   : knowledgeDocs.map((d) => d.text),
		});
		const messages       = [
			...buildHistory(input.conversationHistory, userMessage),
			{role: 'user' as const, content: await this.buildUserContent(userMessage, input.attachments, attachmentService, log)},
		];
		log('info', 'Claude API', `Model ${MAIN_MODEL}, effort ${effort}, ${toolset.tools.length} tools, ${messages.length} messages`,
			`tools: ${toolset.tools.map((t) => t.definition.name).join(', ')}\nknowledge docs: ${knowledgeDocs.length}\nworking summary: ${workingSummary.length} chars`);

		onEvent?.({type: 'RUN_STARTED', model: MAIN_MODEL});
		onProgress?.('Jørgen is thinking...');

		let finalText  = '';
		let stopReason = '';
		for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
			const lastTurn = turn === MAX_AGENT_TURNS - 1;
			const stream   = client.beta.messages.stream({
				model        : MAIN_MODEL,
				max_tokens   : MAX_OUTPUT_TOKENS,
				system,
				messages,
				tools        : toolset.tools.map((t) => t.definition),
				tool_choice  : lastTurn ? {type: 'none'} : {type: 'auto'},
				thinking     : {type: 'adaptive', display: 'summarized'},
				output_config: {effort},
				cache_control: {type: 'ephemeral'},
				betas        : [FALLBACK_BETA],
				fallbacks    : 'default',
			}, {signal});

			const turnId     = `turn-${turn}`;
			let textStarted  = false;
			let thinkingText = '';
			stream.on('streamEvent', (event) => {
				if (event.type === 'content_block_start') {
					const block = event.content_block;
					if (block.type === 'text' && !textStarted) {
						textStarted = true;
						onEvent?.({type: 'TEXT_MESSAGE_START', messageId: turnId, role: 'assistant'});
					} else if (block.type === 'thinking') {
						thinkingText = '';
						onEvent?.({type: 'STEP_STARTED', stepType: 'thinking'});
					} else if (block.type === 'tool_use') {
						onEvent?.({type: 'TOOL_CALL_START', toolCallId: block.id, toolName: block.name});
						onProgress?.(`Using ${block.name}...`);
					}
				} else if (event.type === 'content_block_delta') {
					if (event.delta.type === 'text_delta') {
						onEvent?.({type: 'TEXT_MESSAGE_CONTENT', messageId: turnId, delta: event.delta.text});
					} else if (event.delta.type === 'thinking_delta') {
						thinkingText += event.delta.thinking;
					}
				} else if (event.type === 'content_block_stop' && thinkingText) {
					onEvent?.({type: 'STEP_FINISHED', stepType: 'thinking', content: thinkingText});
					thinkingText = '';
				}
			});

			const message = await stream.finalMessage();
			if (textStarted) {
				onEvent?.({type: 'TEXT_MESSAGE_END', messageId: turnId, role: 'assistant'});
			}
			stopReason  = message.stop_reason ?? '';
			const usage = message.usage;
			log('api', 'Claude API', `Turn ${turn + 1}: stop=${stopReason}, served by ${message.model}`,
				`input=${usage.input_tokens} cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0} output=${usage.output_tokens}`);

			if (stopReason === 'refusal') {
				finalText = 'Jørgen kan ikke hjælpe med denne forespørgsel. / Jørgen cannot help with this request.';
				break;
			}
			if (stopReason === 'pause_turn') {
				messages.push({role: 'assistant', content: message.content as ContentBlockParam[]});
				continue;
			}

			const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
			if (stopReason !== 'tool_use' || toolUses.length === 0) {
				finalText = extractText(message.content);
				break;
			}

			messages.push({role: 'assistant', content: message.content as ContentBlockParam[]});
			const results = await Promise.all(toolUses.map(async (toolUse) => {
				const startedMs             = Date.now();
				const handler               = toolByName.get(toolUse.name);
				const result: ToolRunResult = handler
					? await handler.run(toolUse.input as Record<string, unknown>)
					: {content: `Unknown tool: ${toolUse.name}`, isError: true};
				onEvent?.({type: 'TOOL_CALL_END', toolCallId: toolUse.id, toolName: toolUse.name, result: result.content.slice(0, 2000)});
				log('tool', 'Tool Call', `${toolUse.name} (${Date.now() - startedMs} ms)${result.isError ? ' - error' : ''}`,
					`input: ${JSON.stringify(toolUse.input)}\n\n${result.content.slice(0, 4000)}`);
				return {toolUse, result};
			}));

			const clarification = results.find((r) => r.result.clarification)?.result.clarification;
			if (clarification) {
				onEvent?.({type: 'RUN_FINISHED', finishReason: 'clarification'});
				return {needsClarification: true, ...clarification};
			}

			const toolResults: ContentBlockParam[] = results.map(({toolUse, result}) => ({
				type       : 'tool_result',
				tool_use_id: toolUse.id,
				content    : result.content,
				is_error   : result.isError || undefined,
			}));
			if (turn + 1 === MAX_AGENT_TURNS - 1) {
				toolResults.push({
					type: 'text',
					text: 'You have reached the tool-call limit for this question. Write your final answer now from what you have found, and say plainly what you could not verify.',
				});
			}
			messages.push({role: 'user', content: toolResults});
		}

		onEvent?.({type: 'RUN_FINISHED', finishReason: stopReason});
		finalText = finalText.trim() || 'Jørgen fik ikke skrevet et svar. Prøv at stille spørgsmålet igen. / Jørgen did not produce an answer. Please try again.';

		const detailedAnswer = evidence.length > 0 ? `${finalText}\n\n${formatEvidence(evidence)}` : finalText;
		const isFirstAnswer  = !(input.conversationHistory ?? []).some((m) => m.role === 'assistant');
		const suggestedTitle = isFirstAnswer ? await this.generateTitle(client, userMessage, finalText, log) : undefined;

		const summaryTask = this.updateWorkingSummary(client, chatId, workingSummary, userMessage, finalText, evidence, chatService, log)
			.finally(() => this.pendingSummaries.delete(chatId));
		this.pendingSummaries.set(chatId, summaryTask);

		return {shortAnswer: finalText, detailedAnswer, suggestedTitle};
	}

	private async buildSystemPrompt(context: {
		toolset: AgentToolset;
		databaseName?: string;
		dbHost?: string;
		databaseIds: string[];
		branch?: string;
		systemName?: string;
		systemKey?: string;
		systemUrl?: string;
		workingSummary: string;
		knowledge: string[];
	}): Promise<Anthropic.Beta.BetaTextBlockParam[]> {
		const {capabilities}     = context.toolset;
		const sections: string[] = [`Today is ${new Date().toISOString().slice(0, 10)}.`];

		const sources: string[] = [];
		if (capabilities.database) {
			const configs = await this.deps!.databaseService.getConfigs();
			const names   = configs.filter((c) => context.databaseIds.includes(c.id)).map((c) => `${c.name} (db_id ${c.id})`);
			sources.push(`- Customer database: "${context.databaseName}" on ${context.dbHost || 'the configured server'}${context.systemName ? ` (system: ${context.systemName})` : ''}. Connection: ${names.join(', ')}.${capabilities.schemaIndex ? '' : ' No schema index is available, so search_schema and describe_table query the live database.'}`);
		} else {
			sources.push('- No customer database is connected to this chat. If the question needs customer data, say that a system/database must be selected for the chat.');
		}
		if (capabilities.localCode || capabilities.remoteCode) {
			sources.push(`- SPY source code, branch "${context.branch || 'default branch'}"${capabilities.localCode ? '' : ' (via GitHub API; search is limited to the default branch)'}.`);
		} else {
			sources.push('- No source code access is configured.');
		}
		if (capabilities.spyCodeAi) {
			sources.push('- The spy-code-ai code index (spy_search_code, spy_search_context).');
		}
		if (capabilities.sentry) {
			sources.push(`- SPY's Sentry error tracking (search_errors, get_error_details)${context.systemKey ? `, filtered to this system (system_key ${context.systemKey})` : ''}.`);
		}
		sections.push(`<available_sources>\n${sources.join('\n')}\n</available_sources>`);

		const systemBaseUrl = normalizeSystemUrl(context.systemUrl);
		if (systemBaseUrl) {
			sections.push(`<customer_system>\nName: ${context.systemName || context.systemKey || 'unknown'}\nBase URL for record links: ${systemBaseUrl}${context.branch ? `\nThe system runs the code on branch ${context.branch}.` : ''}\n</customer_system>`);
		}

		if (capabilities.spyCodeAi) {
			const guidance = await loadPromptAsset(SPY_CODE_AI_PROMPT);
			if (guidance) {
				sections.push(`<spy_code_ai_guidance>\n${guidance}\n</spy_code_ai_guidance>`);
			}
		}
		if (context.workingSummary) {
			sections.push(`<working_summary>\nNotes from earlier in this chat (table names, queries, files and conclusions). Use them as leads, and re-check anything the answer depends on.\n\n${context.workingSummary}\n</working_summary>`);
		}
		if (context.knowledge.length > 0) {
			sections.push(`<knowledge_base_matches>\nExcerpts from the internal SPY knowledge base that matched the question (may be partial or irrelevant):\n\n${context.knowledge.map((k) => k.slice(0, 3000)).join('\n\n---\n\n')}\n</knowledge_base_matches>`);
		}

		return [
			{type: 'text', text: STATIC_SYSTEM_PROMPT, cache_control: {type: 'ephemeral'}},
			{type: 'text', text: sections.join('\n\n')},
		];
	}

	private async buildUserContent(
		text: string,
		attachments: AttachmentMeta[] | undefined,
		attachmentService: AttachmentService,
		log: DebugLogFn,
	): Promise<ContentBlockParam[]> {
		const blocks: ContentBlockParam[] = [];
		for (const att of attachments ?? []) {
			try {
				const mime = (att.mimeType || '').toLowerCase();
				if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) {
					const data = (await attachmentService.readAttachmentBuffer(att.storedPath)).toString('base64');
					blocks.push({type: 'image', source: {type: 'base64', media_type: mime as 'image/png', data}});
				} else if (mime === 'application/pdf') {
					const data = (await attachmentService.readAttachmentBuffer(att.storedPath)).toString('base64');
					blocks.push({type: 'document', source: {type: 'base64', media_type: 'application/pdf', data}, title: att.originalName});
				} else {
					const extracted = await attachmentService.extractTextForClaude(att.storedPath, att.mimeType, 200_000);
					blocks.push({
						type: 'text',
						text: extracted.text
							? `<attachment name="${att.originalName}">\n${extracted.text}${extracted.truncated ? '\n[truncated]' : ''}\n</attachment>`
							: `<attachment name="${att.originalName}" type="${att.mimeType}">(binary file - contents not readable)</attachment>`,
					});
				}
			} catch (error) {
				log('error', 'Attachments', `Could not read ${att.originalName}`, String(error));
			}
		}
		blocks.push({type: 'text', text});
		return blocks;
	}

	private async generateTitle(client: Anthropic, question: string, answer: string, log: DebugLogFn): Promise<string | undefined> {
		try {
			const response = await client.messages.create({
				model     : LIGHT_MODEL,
				max_tokens: 60,
				messages  : [{
					role   : 'user',
					content: `Write a chat title of 3-6 words describing the topic of this support conversation, in the language of the question. Keep identifiers (order/return numbers, module and integration names). Output only the title.\n\n<question>${question.slice(0, 2000)}</question>\n<answer>${answer.slice(0, 2000)}</answer>`,
				}],
			});
			const title    = extractText(response.content).replace(/^["'#*\s]+|["'*\s]+$/g, '').split('\n')[0].trim();
			return title ? title.slice(0, 60) : undefined;
		} catch (error) {
			log('error', 'Chat Title', 'Title generation failed', String(error));
			return undefined;
		}
	}

	private async updateWorkingSummary(
		client: Anthropic,
		chatId: string,
		previous: string,
		question: string,
		answer: string,
		evidence: EvidenceItem[],
		chatService: ChatService,
		log: DebugLogFn,
	): Promise<void> {
		try {
			const response = await client.messages.create({
				model     : LIGHT_MODEL,
				max_tokens: 3000,
				messages  : [{
					role   : 'user',
					content: `You maintain the working notes for an ongoing support chat in which an assistant investigates a SPY system's database and source code. The assistant will read these notes at the start of each later turn instead of the full history, so keep what it needs to continue: confirmed facts and numbers, the records in focus (order/customer/return numbers), exact table and column names and SQL patterns that worked (and ones that failed), code files and functions involved, the latest conclusion, and open questions. Drop anything superseded.

Write plain text with short sections and bullet points, at most about 40 bullets. Output only the notes.

<previous_notes>
${previous || '(none)'}
</previous_notes>

<latest_question>
${question.slice(0, 4000)}
</latest_question>

<what_the_assistant_looked_at>
${formatEvidence(evidence, 60) || '(no tools used)'}
</what_the_assistant_looked_at>

<latest_answer>
${answer.slice(0, 12000)}
</latest_answer>`,
				}],
			});
			const summary  = extractText(response.content).trim();
			if (summary) {
				await chatService.setWorkingSummary(chatId, summary);
				log('info', 'Working Summary', `Updated (${summary.length} chars)`, summary.slice(0, 500));
			}
		} catch (error) {
			log('error', 'Working Summary', 'Failed to update working summary', String(error));
		}
	}
}

function normalizeSystemUrl(url?: string): string | undefined {
	const trimmed = url?.trim();
	if (!trimmed) {
		return undefined;
	}
	const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const parsed = new URL(withProtocol);
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return undefined;
	}
}

function extractText(content: Array<{ type: string }>): string {
	return content
		.filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
		.map((b) => b.text)
		.join('\n\n')
		.trim();
}

/** Rebuilds prior turns from the chat transcript the renderer sends. */
function buildHistory(history: Array<{ role: string; content: string }> | undefined, currentMessage: string): MessageParam[] {
	const items = (history ?? [])
		.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() !== '')
		.map((m) => ({role: m.role as 'user' | 'assistant', content: m.content}));

	// Older renderers included the message being sent as the last history entry.
	const last = items[items.length - 1];
	if (last && last.role === 'user' && last.content.trim() === currentMessage.trim()) {
		items.pop();
	}

	const recent = items.slice(-MAX_HISTORY_ITEMS);
	while (recent.length > 0 && recent[0].role !== 'user') {
		recent.shift();
	}
	return recent.map((m) => ({
		role   : m.role,
		content: m.content.length > MAX_HISTORY_CHARS ? `${m.content.slice(0, MAX_HISTORY_CHARS)}\n[...]` : m.content,
	}));
}

function formatEvidence(evidence: EvidenceItem[], limit: number = 40): string {
	if (evidence.length === 0) {
		return '';
	}
	const titles: Record<EvidenceItem['kind'], string> = {
		sql        : 'Database queries',
		schema     : 'Table lookups',
		code_search: 'Code searches',
		file       : 'Files read',
		history    : 'Code history',
		csv        : 'CSV exports',
		knowledge  : 'Knowledge base searches',
		mcp        : 'Code index searches',
		sentry     : 'Error lookups (Sentry)',
	};
	const lines: string[]                              = ['---', '**Investigation details**'];
	for (const kind of Object.keys(titles) as Array<EvidenceItem['kind']>) {
		const items = evidence.filter((e) => e.kind === kind);
		if (items.length === 0) {
			continue;
		}
		lines.push('', `*${titles[kind]}*`);
		for (const item of items.slice(0, limit)) {
			const detail = item.detail ? ` — ${item.detail}` : '';
			if (kind === 'sql') {
				lines.push('```sql', item.label.trim(), '```', detail ? `→ ${item.detail}` : '');
			} else {
				lines.push(`- \`${item.label.replace(/`/g, "'")}\`${detail}`);
			}
		}
		if (items.length > limit) {
			lines.push(`- … ${items.length - limit} more`);
		}
	}
	return lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
}

const STATIC_SYSTEM_PROMPT = `You are Jørgen ("Spørge Jørgen"), the assistant for SPY's customer support staff. SPY is a warehouse management and e-commerce system used by fashion and lifestyle brands. The people asking you are support staff, not developers: they need to understand what happened in a customer's SPY system, why, and what the customer should do.

You investigate with tools: read-only SQL against the customer's database, search and read the SPY source code, and SPY's internal knowledge base. The database and the code are the source of truth - look things up rather than relying on general knowledge or assumptions.

# Language
Reply in the language the user writes in (usually Danish). SPY's user interface is in English, so keep SPY terms and screen labels in English exactly as they appear in the system (for example consignment, style, assortment, brand, season, shipment, packing, claim, return, POS, B2B, B2C, EDI) - in Danish text write "consignment-kunde", not "konsignationskunde".

# How to investigate
- When the question mentions a specific record (order, return, invoice, customer, style, shipment - with or without a number), look it up in the database instead of asking the user for details.
- For data questions: find the table with search_schema, check its columns with describe_table, then query. Never guess table or column names; when a query fails, use the error and the suggestions to correct it.
- For "how does X work" or "how do I set up Y": find the code that implements it (search_code, find_files, read_file) and base the answer on what the code does. Trust the code over code comments, which can be outdated.
- For "why does page X show Y": find the page's code, see how it selects its data, and reproduce that query - don't substitute your own logic for the page's.
- Combine database and code when needed: data tells you what happened, code tells you why.
- "It worked before" / "after the update": use file_history (with search for the relevant code) and compare_branches between release branches (named YYYY_MM, e.g. 2026_07 -> 2026_09) to find the commit that changed the behaviour and the first release that shipped it.
- Error reports ("fejl", "virker ikke", an error message or a crashing page): check Sentry with search_errors for this system, read the stack trace with get_error_details, then read the code at the lines in the trace.
- Run independent lookups in parallel.
- If something cannot be found or verified, say specifically what you could not verify, instead of guessing.

# SPY system knowledge
- Backend PHP with an entity-based ORM; frontend TypeScript/React. Hungarian notation is common (iID, strName, bActive, fPrice).
- Columns are rarely NULL: 0 means "not set" for integers and '' for text. Most tables have added_user_id, added_date, changed_user_id, changed_date.
- "Active" usually means disabled = 0 (there is typically no is_active column). "Active customers" as shown on Customers > Active means disabled = 0 AND type != 'b2c' (the page also filters by brand access).
- Never query views whose names start with bi_ (BI views); use the underlying tables.
- Consignment affects orders, customers, stock and integrations. POS integrations such as Shopify POS require the customer to be a consignment customer (customers.is_consignment_customer). Check whether consignment matters when answering about integrations, order flow or customers.
- Code layout: pages in modules/<module>/index.php or view.php; actions/handlers (dialogs and AJAX operations, not separate pages) in modules/<module>/action.php, action_*.php or _action.php; MVC controllers in applications/Spy/Controller/...; TypeScript controllers in public/javascript/Controller/....
- UI actions: an element with data-spyaction="OpenCustomer|click" calls OpenCustomerAction() in the page's TypeScript controller, which calls a PHP controller (new Get(...)/new Post(...)) whose HTML is shown with showDialog(). To explain a dialog, follow that chain.
- Forms often show different fields when creating vs editing, and some fields are display-only. Check the code before telling a user to fill in a field, and say when a field only appears in one mode.

# Writing the answer
The user only sees your final message - not your tool calls, their results, or text you wrote between tool calls. Before a tool call you may write one short sentence (in the user's language) about what you are checking; it is shown as a progress note and then replaced. Your final message must stand on its own.
- Lead with the answer to the question, then the supporting details.
- Write for support staff: plain language, concrete steps. Give UI instructions with the exact menu, button and field labels, and only labels or menu paths you actually saw in the code during this conversation.
- Leave out table names, column names, SQL and file paths unless the user asks for technical details or is clearly a developer; they are listed automatically under "Details".
- Show checkbox/boolean settings as Enabled/Disabled (Danish: Slået til/Slået fra), never 1/0.
- Use a markdown table for lists of records with several attributes; put key numbers in bold.
- Keep responses focused, brief, and concise to avoid overwhelming the person. Disclaimers and caveats are brief, with most of the response on the main answer.
- Link records you mention into the customer's system when <customer_system> gives a base URL, as markdown links. Use the record's internal id from the database (the column shown in parentheses), not a displayed number, and only ids you actually looked up. URL paths (append to the base URL):
  - Sales order (s_order_main.id): /go/sales-order/{id}
  - Customer (customers.id): /?controller=Admin%5CCustomer%5CEdit&action=Edit&customer_id={id}
  - Style (styles.sId): /styles.php?mode=Edit&id={id}
  - Return/claim (claims.claims_id): /app/sales/claims/show/{id}
  - Delivery/shipment (packing_master.id): /?controller=Sale%5CDelivered%5CDetails&action=Show&iPackingMasterID={id}
  - Packing instruction (packing_instruction.instruction_id): /packing.php?mode=Edit&id={id}
  - Purchase order (p_order_main.id): /purchase_orders.php?mode=Edit&p_order_main_id={id}
  - Invoice (s_order_invoice_no.invoice_id, opens the invoice list filtered to it): /?controller=Sale%5CInvoiced&action=List&invoice_ids={id}
  - Supplier (suppliers.id): /?controller=Admin%5CSupplier%5CEdit&action=GetEdit&iSupplierID={id}
  - User (users.uId): /?controller=Admin%5CUser%5CEdit&action=Edit&user_id={id}
  - Brand (brands.dpId): /?controller=Admin%5CBrand%5CEdit&action=GetEdit&brand_id={id}
  - Season (seasons.season_id): /?controller=Admin%5CSettings%5CStyle%5CSeason%5CEdit&action=GetEditSeasonView&iSeasonID={id}
  - Shopify shop (shopify_shops.id): /?controller=Admin%5CSettings%5CIntegration%5CShopify%5CShop%5CEdit&action=GetEdit&iShopifyShopID={id}
  - Shopify order mapping (shopify_order_mappings.id): /?controller=Admin%5CSettings%5CIntegration%5CShopify%5COrder%5CMapping%5CEdit&action=Edit&iShopifyOrderMappingID={id}
  Other records (assortment templates, EDI messages, Shopify orders) have no page of their own - do not invent URLs for them.
- When numbers are easier to understand as a picture - a trend over time, or a comparison across a handful of categories - add a chart as a fenced code block with the language "chart" containing JSON:
  {"type": "bar" | "line", "title": "...", "unit": "optional unit", "x": ["label1", "label2", ...], "series": [{"name": "...", "values": [number, ...]}]}
  Use "line" for time series (x = dates in order) and "bar" to compare categories (sorted by value unless the order is meaningful; add "horizontal": true for long labels). At most 4 series; one value per x label (null for missing). Only chart numbers you queried, and keep the key numbers in the text too. Do not chart a single number.
- When the user wants a list, export, extract or overview they will use outside the chat ("liste", "udtræk", "oversigt", "export"), save it with export_to_csv and tell them the file name - it is in their Downloads folder.

# Boundaries
- You have read-only access. Never write or suggest INSERT/UPDATE/DELETE/ALTER or other write SQL, and never offer to change data or code. If something needs fixing, explain the cause, how to verify it, and that a developer or administrator must make the change.
- Deliver what the user asked for, at the scope they intended. Make routine judgment calls yourself. Use ask_clarifying_question only when you cannot find the missing information with your tools and different interpretations would lead to materially different answers.

<tone_preference>
Keep outputs reasonably concise.
</tone_preference>`;
