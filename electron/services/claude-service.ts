import type {DatabaseService} from './database-service';
import type {GitHubService} from './github-service';
import {SecureStorageService} from './secure-storage-service';
import type {SchemaIndexService} from './schema-index-service';
import type {ChatService} from './chat-service';
import type {AttachmentMeta, AttachmentService} from './attachment-service';
import {VectorStoreService} from './vector-store-service';
import {createClaudeTools, exportToCsvFile} from './claude-tools';

type ChatMessage = { role: 'user' | 'assistant'; content: any };

export class ClaudeService {
	private readonly secureStorage: SecureStorageService;
	private apiKeyCache: string | null             = null;
	private vectorStore: VectorStoreService | null = null;

	constructor(secureStorage: SecureStorageService) {
		this.secureStorage = secureStorage;
	}

	private async ensureVectorStore(): Promise<VectorStoreService | null> {
		if (this.vectorStore) {
			return this.vectorStore;
		}

		try {
			const apiKey = await this.getApiKey();
			if (!apiKey) {
				return null;
			}

			this.vectorStore = new VectorStoreService(apiKey);
			await this.vectorStore.initialize();
			return this.vectorStore;
		} catch (error) {
			console.error('Error initializing vector store:', error);
			return null;
		}
	}

	async getApiKey(): Promise<string | null> {
		// Load from encrypted storage
		const key = await this.secureStorage.loadEncrypted('claude-api-key');
		return key ? key.trim() : null;
	}

	async saveApiKey(apiKey: string): Promise<void> {
		// Trim whitespace and validate
		const trimmedKey = apiKey.trim();

		if (!trimmedKey.startsWith('sk-ant-')) {
			throw new Error('Invalid API key format. Must start with "sk-ant-"');
		}

		// Save to encrypted storage
		await this.secureStorage.saveEncrypted('claude-api-key', trimmedKey);
		this.apiKeyCache = trimmedKey;
	}

	private async ensureApiKey(): Promise<string> {
		if (this.apiKeyCache) {
			return this.apiKeyCache;
		}

		const apiKey = await this.getApiKey();
		if (!apiKey) {
			throw new Error('Claude API key not configured');
		}

		this.apiKeyCache = apiKey;
		return apiKey;
	}

	async sendMessage(
		chatId: string,
		userMessage: string,
		databaseIds: string[],
		databaseService: DatabaseService,
		githubService: GitHubService,
		schemaIndexService: SchemaIndexService,
		chatService: ChatService,
		attachmentService: AttachmentService,
		onProgress?: (status: string) => void,
		conversationHistory?: Array<{ role: string; content: string }>,
		databaseName?: string,
		dbHostOverride?: string,
		githubBranchOverride?: string,
		attachments?: AttachmentMeta[],
		onDebugLog?: (type: 'query' | 'tool' | 'api' | 'error' | 'info', category: string, message: string, details?: string) => void,
		onEvent?: (event: unknown) => void,
		abortController?: AbortController,
	): Promise<{ shortAnswer: string; detailedAnswer: string; suggestedTitle?: string } | {
		needsClarification: true;
		question: string;
		options?: string[];
		allowFreeText?: boolean
	}> {
		const detectDesiredDetailLevel = (text: string): 'short' | 'medium' | 'detailed' => {
			const t = text.toLowerCase();

			// If the user explicitly asks for technical artifacts or deeper explanation, allow more detail.
			const asksForTechnical  = /(\bcode\b|\bkode\b|\bsql\b|\bquery\b|\bklasse\b|\bclass\b|\bfil\b|\bfile\b|\blinje\b|\bline\b|\bstack\b|\btrace\b|\bfejl\b|\berror\b|\bdebug\b|\bipc\b|\belectron\b|\bnode\b|\breact\b|\btypescript\b|\bapi\b)/i
				.test(t);
			const asksForMoreDetail = /(\bdetalj|detaljer|uddyb|uddybning|forklar|forklaring|explain|deep|dyb|mere\b)/i
				.test(t);
			const asksForSteps      = /(\btrin\b|\bsteps?\b|\bstep-by-step\b|\bpunkt(?:er)?\b|\bcheckliste\b)/i
				.test(t);

			if (asksForTechnical || asksForMoreDetail) {
				return 'detailed';
			}
			if (asksForSteps) {
				return 'medium';
			}
			return 'short';
		};

		const looksLikeUiQuestion = (text: string): boolean => {
			const t = text.toLowerCase();
			// Danish + English UI intent keywords
			return /(\bhvordan\b|\bhvor\b|\bklik\b|\bknap\b|\bmenu\b|\bfane\b|\bfelt\b|\bside\b|\bskærm\b|\bui\b|\binterface\b|\bfind\b|\bopret\b|\bredig(é|e)r\b|\bslet\b|\bfilter\b|\bsøg\b|\bexport\b|\budtræk\b|\boversigt\b|\bwhy\b|\bwhere\b|\bbutton\b|\bmenu\b|\bpage\b|\bfield\b)/i
				.test(t);
		};

		/**
		 * Detect if the question is about setting up or configuring an integration.
		 * These questions MUST search the codebase first to give the COMPLETE picture with ALL critical steps.
		 * Integration setups often have non-obvious requirements (config tables, API keys, webhooks, linking).
		 */
		const detectsIntegrationSetupQuestion = (text: string): boolean => {
			const t = text.toLowerCase();

			// Setup/configuration intent
			const setupIntent = /\b(opsæt|opsætte|opsætter|setup|oprette|konfigurer|configure|knytte|knytter|connect|link|forbinde|tilkoble|integrat|integration)\b/i.test(t);

			// Known SPY integrations
			const integrationMention = /\b(shopify|pos|woocommerce|sitoo|edi|nemedi|dhl|ups|fedex|gls|postnord|bring|webhook|api\s+key)\b/i.test(t);

			// "How do I set up X in Spy" or "how to connect X to Y"
			if (setupIntent && integrationMention) {
				return true;
			}

			// Explicit "how to set up [integration]" patterns
			if (/\b(hvordan|how)\s+(opsætter|set\s+up|setup|konfigurerer|configure)\s+(jeg|i|we)?\s*(shopify|pos|woo|sitoo|edi|integration)/i.test(t)) {
				return true;
			}

			// "knytter til min shop" / "connect to my shop"
			if (/\b(knytte|connect|link)\s+(til|to)\s+(min|mit|my)\s*(shop|butik)/i.test(t)) {
				return true;
			}

			return false;
		};

		/**
		 * Detect if the question is about a specific SPY page/module behavior.
		 * These questions need CODE SEARCH FIRST to understand how the page works.
		 */
		const detectsPageModuleQuestion = (text: string): boolean => {
			const t = text.toLowerCase();

			// Questions about what a page shows or why
			if (/\b(side(n)?|page|modul|module|skærm|screen|liste|list|oversigt|overview)\s+(viser|shows|har|has)\b/i.test(t)) {
				return true;
			}

			// "Why does X show Y" patterns
			if (/\b(hvorfor|why)\s+(viser|shows|står|er)\b/i.test(t)) {
				return true;
			}

			// Specific SPY module mentions with behavioral questions
			if (/\b(confident|topseller|sales\/create|b2b|b2c|claims|warehouse)\b/i.test(t) &&
				/\b(viser|shows|default|standard|forkert|wrong|anderledes|different)\b/i.test(t)) {
				return true;
			}

			// Questions comparing two views/pages
			if (/\b(forskellig|different|anderledes|ikke det samme|not the same)\b/i.test(t) &&
				/\b(side|page|modul|module|sted|place)\b/i.test(t)) {
				return true;
			}

			return false;
		};

		// Status detection removed - vector store knowledge handles this directly.

		/**
		 * Detect if the question is about a SPY handler, action, modal, or dialog.
		 * These questions need the TS controller → PHP controller navigation strategy.
		 */
		const detectsHandlerOrActionQuestion = (text: string): boolean => {
			const t = text.toLowerCase();

			// Direct "action-something" or "action_something" mentions
			if (/\baction[-_]\w+/i.test(t)) {
				return true;
			}

			// "spyaction" or "data-spyaction" mentions
			if (/\b(spy\s*action|data-spyaction)\b/i.test(t)) {
				return true;
			}

			// Handler/action keywords combined with SPY context
			if (/\b(handler|action|modal|dialog|popup|dialogue|dialogboks)\b/i.test(t) &&
				/\b(spy|modul|module|side|page|knap|button|klik|click|åbn|open|luk|close|viser|shows)\b/i.test(t)) {
				return true;
			}

			// "When you click X, a dialog/modal opens" patterns (DA + EN)
			if (/\b(åbner?|opens?|viser|shows|popper?\s+op|pops?\s+up)\b/i.test(t) &&
				/\b(dialog|modal|popup|vindue|window|boks|box|formular|form)\b/i.test(t)) {
				return true;
			}

			// "Open[Something]" action-style names
			if (/\bopen[A-Z]\w+/i.test(t) || /\bshow[A-Z]\w+dialog/i.test(t)) {
				return true;
			}

			// Questions about what happens when a button is clicked (handler behavior)
			if (/\b(hvad\s+sker|what\s+happens)\b/i.test(t) &&
				/\b(klik|click|tryk|press|knap|button)\b/i.test(t)) {
				return true;
			}

			return false;
		};

		/**
		 * Detect if the question is clearly about data/counts/records that require database access.
		 * VERY inclusive - better to check DB when unnecessary than miss a DB question.
		 */
		const detectsDatabaseQuestion = (text: string): boolean => {
			const t = text.toLowerCase();

			// Count/aggregate questions
			if (/\b(hvor\s+mange|how\s+many|antal|count|total|sum|average|gennemsnit)\b/i.test(t)) {
				return true;
			}

			// List questions
			if (/\b(vis\s+(mig\s+)?(alle|en\s+liste)|show\s+(me\s+)?(all|a\s+list)|list\s+all|hvilke|which)\b/i.test(t)) {
				return true;
			}

			// Specific record lookups (order, customer, invoice, return, etc.)
			if (/\b(ordre|order|kunde|customer|faktura|invoice|retur|return|produkt|product|vare|item|leverandør|supplier|brand|sælger|seller|user|bruger)\s*[:#]?\s*\d+\b/i.test(t)) {
				return true;
			}

			// Any number that looks like an ID (even standalone numbers > 3 digits)
			if (/\b(id|nummer|number|#)\s*:?\s*\d+/i.test(t)) {
				return true;
			}
			// Standalone numbers that look like IDs (4+ digits or with # prefix)
			if (/#\d+|\b\d{4,}\b/.test(t)) {
				return true;
			}

			// Questions about "i systemet" (in the system) typically need DB
			if (/\bi\s+(mit\s+)?system(et)?\b/i.test(t)) {
				return true;
			}

			// Entity nouns that almost always need DB lookup
			const entityNouns = /\b(brugere?|users?|kunder?|customers?|ordrer?|orders?|produkter?|products?|varer?|items?|fakturaer?|invoices?|returneringer?|returns?|leverandører?|suppliers?|brands?|sælgere?|sellers?|lager|stock|inventory|shipments?|forsendelser?|betalinger?|payments?)\b/i;
			if (entityNouns.test(t)) {
				return true;
			}

			// Questions about status, amounts, dates
			if (/\b(status|saldo|balance|beløb|amount|pris|price|dato|date|oprettet|created|ændret|changed|aktiv|active|inaktiv|inactive|disabled)\b/i.test(t)) {
				return true;
			}

			// Investigation questions
			if (/\b(hvorfor|why|hvornår|when|hvem|who|tjek|check|undersøg|investigate|find\s+ud\s+af|find\s+out)\b/i.test(t)) {
				return true;
			}

			// Module mentions (SPY modules)
			if (/\b(sales|b2b|b2c|shopify|edi|claims|warehouse|shipping|confident)\b/i.test(t)) {
				return true;
			}

			return false;
		};

		const extractSearchKeywords = (text: string, max: number = 4): string[] => {
			const stop  = new Set([
				'hvordan', 'hvor', 'hvad', 'hvem', 'hvorfor', 'kan', 'jeg', 'vi', 'man', 'min', 'mit', 'mine',
				'det', 'den', 'der', 'som', 'til', 'på', 'i', 'af', 'og', 'eller', 'med', 'fra', 'for', 'at',
				'the', 'a', 'an', 'and', 'or', 'to', 'in', 'on', 'of', 'for', 'with', 'is', 'are', 'do', 'does',
			]);
			const words = (text.toLowerCase().match(/[a-zæøå0-9_]+/gi) || [])
				.map((w) => w.trim())
				.filter((w) => w.length >= 4 && !stop.has(w));
			return Array.from(new Set(words)).slice(0, max);
		};

		const formatUiCodeSearchResults = (results: Array<{ path: string; matches: string[] }>): string => {
			if (!results || results.length === 0) {
				return '';
			}
			const lines: string[] = [];
			lines.push('UI CODE SEARCH RESULTS (SPY REPO)');
			lines.push('Use these to ground exact menu/button/field labels. Do NOT invent labels.');
			for (const r of results.slice(0, 5)) {
				lines.push(`- ${r.path}`);
				for (const m of (r.matches || []).slice(0, 3)) {
					const frag = String(m || '').replace(/\s+/g, ' ').trim();
					if (frag) {
						lines.push(`  - ${frag}`);
					}
				}
			}
			return lines.join('\n');
		};

		const formatIntegrationCodeSearchResults = (results: Array<{ path: string; matches: string[] }>): string => {
			if (!results || results.length === 0) {
				return '';
			}
			const lines: string[] = [];
			lines.push('SETUP/HOW-TO CODE SEARCH RESULTS (SPY REPO)');
			lines.push('Use these to document ALL setup steps. Do NOT skip critical config, webhooks, or linking logic.');
			for (const r of results.slice(0, 8)) {
				lines.push(`- ${r.path}`);
				for (const m of (r.matches || []).slice(0, 4)) {
					const frag = String(m || '').replace(/\s+/g, ' ').trim();
					if (frag) {
						lines.push(`  - ${frag}`);
					}
				}
			}
			return lines.join('\n');
		};

		// Get database connection info for context
		let dbServerHost = '';
		if (dbHostOverride && String(dbHostOverride).trim() !== '') {
			dbServerHost = String(dbHostOverride).trim();
		} else if (databaseIds.length > 0) {
			const configs = await databaseService.getConfigs();
			const config  = configs.find((c) => c.id === databaseIds[0]);
			if (config) {
				dbServerHost = config.host;
			}
		}
		let dbIdContext = '';
		if (databaseIds.length > 0) {
			const configs = await databaseService.getConfigs();
			const allowed = configs.filter((c) => databaseIds.includes(c.id));
			if (allowed.length > 0) {
				dbIdContext = allowed.map((c) => `- ${c.name}: ${c.id}`).join('\n');
			}
		}
		const apiKey                                           = await this.ensureApiKey();
		const [{maxIterations}, {chat}, {createAnthropicChat}] = await Promise.all([
			import('@tanstack/ai'),
			import('@tanstack/ai/adapters'),
			import('@tanstack/ai-anthropic'),
		]);

		onProgress?.('Preparing tools...');

		const queryResults: Array<{ query: string; data: any[] }> = [];
		const {tools, resetSearchCounter}                         = await createClaudeTools({
			databaseService,
			githubService,
			schemaIndexService,
			databaseIds,
			databaseName,
			dbHostOverride,
			githubBranchOverride,
			onProgress,
			onDebugLog,
			queryResults,
		});


		// Start conversation with history if provided
		const messages: ChatMessage[] = [];

		if (conversationHistory && conversationHistory.length > 0) {
			// Add all previous messages
			for (const msg of conversationHistory) {
				messages.push({
					role   : msg.role as 'user' | 'assistant',
					content: msg.content,
				});
			}
		}

		// Add the new user message (with optional attachments).
		// TanStack AI ContentPart format:
		//   TextPart:  { type: 'text', content: string }
		//   ImagePart: { type: 'image', source: { type: 'data' | 'url', value: string }, metadata?: { mediaType } }
		let userText = userMessage;
		const contentBlocks: Array<{
			type: string;
			content?: string;
			source?: { type: 'url' | 'data'; value: string };
			metadata?: { mediaType?: string };
		}>           = [];
		try {
			if (attachments && attachments.length > 0) {
				onProgress?.(`Processing ${attachments.length} attachment(s)...`);
				for (const att of attachments) {
					if (att.mimeType && att.mimeType.startsWith('image/')) {
						const buf    = await attachmentService.readAttachmentBuffer(att.storedPath);
						const base64 = buf.toString('base64');
						contentBlocks.push({
							type    : 'image',
							source  : {
								type : 'data',
								value: base64,
							},
							metadata: {
								mediaType: att.mimeType as string,
							},
						});
						continue;
					}

					const extracted = await attachmentService.extractTextForClaude(att.storedPath, att.mimeType, 40_000);
					if (extracted.text.trim() !== '') {
						userText += `\n\nATTACHMENT: ${att.originalName} (${att.mimeType}, ${Math.round(att.sizeBytes / 1024)} KB)\n${extracted.text}${extracted.truncated ? '\n\n[Truncated]' : ''}`;
					} else {
						userText += `\n\nATTACHMENT: ${att.originalName} (${att.mimeType}, ${Math.round(att.sizeBytes / 1024)} KB)\n[Binary or unsupported file type for text extraction]`;
					}
				}
				onDebugLog?.('info', 'Attachments', `Included ${attachments.length} attachment(s) in message`);
			}
		} catch (error) {
			onDebugLog?.('error', 'Attachments', 'Failed to process attachments', String(error));
		}

		if (attachments && attachments.length > 0) {
			contentBlocks.unshift({type: 'text', content: userText});
			messages.push({
				role   : 'user',
				content: contentBlocks,
			});
		} else {
			messages.push({
				role   : 'user',
				content: userMessage,
			});
		}

		// For UI questions, proactively search the connected SPY repo for relevant labels/components.
		let uiCodeSearchSection = '';
		try {
			const isUi = looksLikeUiQuestion(userMessage);
			if (isUi) {
				await githubService.getConfig();
				onProgress?.('Searching UI codebase...');
				const keywords      = extractSearchKeywords(userMessage, 4);
				// Prefer keyword query; fallback to user text if needed.
				const query         = keywords.length > 0 ? keywords.join(' ') : userMessage;
				const uiResults     = await githubService.searchCode(query);
				uiCodeSearchSection = formatUiCodeSearchResults(uiResults);
				if (uiResults.length > 0) {
					onDebugLog?.('info', 'UI Grounding', `Found ${uiResults.length} code search results for: ${query}`);
				} else {
					// Always include an explicit "no results" marker to block hallucinations.
					uiCodeSearchSection = [
						'UI CODE SEARCH RESULTS (SPY REPO)',
						`Query: ${query}`,
						'Results: NONE',
						'RULE: Do NOT invent file paths, function names, or UI labels. If results are NONE, say you cannot find it and ask for the exact module/page name or a screenshot.',
					].join('\n');
					onDebugLog?.('info', 'UI Grounding', `No code search results for: ${query}`);
				}
			}
		} catch (error) {
			onDebugLog?.('error', 'UI Grounding', 'UI code search failed', String(error));
		}

		/**
		 * Broader: any "how to" or "setup" question that benefits from code search.
		 * Includes integration setup but also generic "hvordan gør jeg X", "where do I configure Y".
		 */
		const looksLikeSetupOrHowToQuestion = (text: string): boolean => {
			const t        = text.toLowerCase();
			const setupHow = /\b(hvordan|how)\s+(opsætter|gør|konfigurerer|set\s+up|setup|configure|do\s+i)\b/i.test(t)
				|| /\b(where|hvor)\s+(do\s+i|finder|kan\s+jeg|opretter|konfigurerer)\b/i.test(t)
				|| /\b(opsæt|opsætte|konfigurer|setup)\s+(jeg|i|we)?\s*(spy|systemet)?/i.test(t);
			return setupHow || detectsIntegrationSetupQuestion(text);
		};

		// For integration/setup/how-to questions, proactively search for config, webhooks, linking logic.
		let integrationCodeSearchSection = '';
		try {
			const isIntegrationOrSetup = looksLikeSetupOrHowToQuestion(userMessage);
			if (isIntegrationOrSetup) {
				await githubService.getConfig();
				onProgress?.('Searching integration codebase...');
				const keywords               = extractSearchKeywords(userMessage, 4);
				// Integration-specific: add terms that often appear in setup code
				const integrationTerms       = ['setup', 'config', 'webhook', 'connect', 'integration', 'pos', 'shopify', 'consignment'];
				const match                  = userMessage.match(/\b(shopify|pos|woocommerce|sitoo|edi|nemedi|webhook)\b/gi);
				const integrationNames       = match ? [...new Set(match.map((m) => m.toLowerCase()))] : [];
				const queryParts             = [...keywords, ...integrationNames, ...integrationTerms.slice(0, 2)];
				const query                  = Array.from(new Set(queryParts)).slice(0, 6).join(' ');
				const integrationResults     = await githubService.searchCode(query);
				integrationCodeSearchSection = formatIntegrationCodeSearchResults(integrationResults);
				if (integrationResults.length > 0) {
					onDebugLog?.('info', 'Setup/How-to Grounding', `Found ${integrationResults.length} code search results for: ${query}`);
				} else {
					integrationCodeSearchSection = [
						'SETUP/HOW-TO CODE SEARCH RESULTS (SPY REPO)',
						`Query: ${query}`,
						'Results: NONE',
						'RULE: You MUST still use search_code/search_code_context in the tool loop to find the actual setup. Do NOT skip. Try alternative search terms (e.g. config, webhook, setup).',
					].join('\n');
					onDebugLog?.('info', 'Setup/How-to Grounding', `No code search results for: ${query}`);
				}
			}
		} catch (error) {
			onDebugLog?.('error', 'Integration Grounding', 'Integration code search failed', String(error));
		}

		onProgress?.('Searching knowledge base...');

		// Search vector store for relevant context
		let contextDocuments: string[] = [];
		try {
			const vectorStore = await this.ensureVectorStore();
			if (vectorStore) {
				// Build context-aware search query from conversation history
				let searchQuery = userMessage;
				if (conversationHistory && conversationHistory.length > 0) {
					// Add recent user messages to give more context for vector search
					const recentUserMessages = conversationHistory
						.filter(msg => msg.role === 'user')
						.slice(-2) // Last 2 user messages
						.map(msg => msg.content);

					if (recentUserMessages.length > 0) {
						searchQuery = [...recentUserMessages, userMessage].join(' ');
						onDebugLog?.('info', 'Vector Store', `Searching with conversation context (${recentUserMessages.length} previous messages)`);
					}
				}

				onDebugLog?.('info', 'Vector Store', `Searching for relevant context for query: "${userMessage.substring(0, 100)}${userMessage.length > 100 ? '...' : ''}"`);
				const relevantDocs = await vectorStore.search(searchQuery, 3);
				contextDocuments   = relevantDocs.map((doc) => doc.text);

				// Log each found document
				if (relevantDocs.length > 0) {
					onDebugLog?.('info', 'Vector Store', `Found ${relevantDocs.length} relevant documents:`);
					relevantDocs.forEach((doc, index) => {
						const preview = doc.text.length > 150 ? doc.text.substring(0, 150) + '...' : doc.text;
						onDebugLog?.('info', 'Vector Store', `  [${index + 1}] ${doc.id}: ${preview}`);
					});
				} else {
					onDebugLog?.('info', 'Vector Store', 'No relevant documents found');
				}
			}
		} catch (error) {
			console.error('Error searching vector store:', error);
			onDebugLog?.('error', 'Vector Store', 'Error searching for context', String(error));
		}

		onProgress?.('Sending message to Jørgen...');

		// Check schema index availability (if DB is connected)
		let schemaIndexInfo: { exists: boolean; generatedAtIso?: string; source?: string; tableCount?: number } | null = null;
		if (databaseName && databaseIds.length > 0) {
			try {
				const configs = await databaseService.getConfigs();
				const config  = configs.find((c) => c.id === databaseIds[0]);
				if (config) {
					const index = await schemaIndexService.loadIndex(config.id);
					if (index) {
						schemaIndexInfo = {
							exists        : true,
							generatedAtIso: index.generatedAtIso,
							source        : index.source,
							tableCount    : index.tables.length,
						};
					} else {
						schemaIndexInfo = {exists: false};
					}
				}
			} catch (error) {
				// Non-fatal: schema index is an optimization only.
				onDebugLog?.('error', 'Schema Index', 'Failed to check schema index status', String(error));
			}
		}

		// Detect if question is about a page/module (needs code search first)
		const requiresCodeFirst = detectsPageModuleQuestion(userMessage);
		if (requiresCodeFirst) {
			onDebugLog?.('info', 'Detection', 'Page/Module question detected - will require code search first');
		}
		const codeFirstDirective = requiresCodeFirst
			? `
**MANDATORY: THIS IS A PAGE/MODULE QUESTION - SEARCH CODE FIRST**
The user is asking about how a SPY page/module behaves. You MUST:
1. FIRST use search_code_context to find the controller/PHP file for that page
2. FIND THE QUERY the page uses to fetch data
3. THEN query the database using the SAME logic as the page
4. Explain based on what the CODE does, not your assumptions
DO NOT just query the database with your own logic. FIND THE PAGE'S LOGIC FIRST.
`
			: '';

		// Status verification directive removed - the vector store knowledge now contains
		// the correct filtering logic for active entities directly.

		// Detect if question is about a handler/action/modal
		const requiresHandlerNav = detectsHandlerOrActionQuestion(userMessage);
		if (requiresHandlerNav) {
			onDebugLog?.('info', 'Detection', 'Handler/Action/Modal question detected - will use handler navigation strategy');
		}
		const handlerDirective = requiresHandlerNav
			? `
**MANDATORY: THIS IS A HANDLER/ACTION/MODAL QUESTION**
The user is asking about a SPY action, handler, dialog, or modal. These are NOT pages - they are overlay dialogs or AJAX operations.
Follow this EXACT search strategy:
1. FIRST: Extract the action name (e.g., "opencustomer" → "OpenCustomer") and search TypeScript files:
   search_code_context("OpenCustomerAction") to find the frontend controller method
2. THEN: Read the TS method to find which PHP controller it calls (look for Get/Post/MVCURL patterns)
3. THEN: read_file on the PHP controller to understand the backend logic
4. ALSO: search_code("data-spyaction=\\"OpenCustomer") to find the HTML trigger element

KEY PATTERNS:
- HTML: data-spyaction="ActionName|event" triggers TypeScript method ActionNameAction()
- TS Controller: Makes AJAX call via new Get<HTMLResponseData>('Controller\\Path', 'MethodName')
- PHP Controller: Returns HTML fragment displayed in showDialog() (jQuery UI Dialog)
- Action files: modules/[module]/action.php (switch on mode), action_*.php, or _action.php

FIELD VISIBILITY (CRITICAL):
- Dialogs/forms often have DIFFERENT fields for Create vs Edit mode. A field visible when editing may NOT exist when creating.
- Search for: conditional rendering, v-if, display logic, mode checks (isNew, isEdit, mode === 'create' vs 'edit').
- When listing form fields, ALWAYS state in which context each field appears: "Visible when creating" vs "Visible when editing" vs "Always visible".
- Do NOT assume all fields are visible at once. Check the code for visibility conditions.
`
			: '';

		// Detect if question requires database (counts, lookups, records)
		const requiresDatabase = detectsDatabaseQuestion(userMessage);
		if (requiresDatabase) {
			onDebugLog?.('info', 'Detection', 'Database question detected - will require database access');
		}
		const databaseDirective = requiresDatabase
			? `
**MANDATORY: THIS QUESTION REQUIRES DATABASE ACCESS**
The user's question contains data-related keywords. You MUST:
1. Use search_schema to find relevant tables
2. Use query_database to get the actual data
3. Include the database results in your answer
DO NOT answer without querying the database first. DO NOT say "I don't have access" - you DO have database access.
`
			: '';

		// Detect if question is about integration setup (Shopify, POS, WooCommerce, etc.)
		const requiresIntegrationFocus = detectsIntegrationSetupQuestion(userMessage);
		if (requiresIntegrationFocus) {
			onDebugLog?.('info', 'Detection', 'Integration setup question detected - will require code-grounded complete answer');
		}
		const integrationDirective = requiresIntegrationFocus
			? `
**MANDATORY: THIS IS AN INTEGRATION SETUP QUESTION - GIVE THE COMPLETE PICTURE**
The user is asking how to set up or configure an integration (e.g. Shopify POS, WooCommerce, Sitoo).
You MUST:
1. use search_code_context / search_code to find ALL setup-related code: config forms, webhook registration, API keys, database tables, linking logic
2. read_file on the relevant files to extract the EXACT steps (menus, fields, checkboxes, prerequisites)
3. Include EVERY critical step - do NOT skip "obvious" or "assumed" steps. Integration setups often fail because of missed config like webhook URLs, API credentials, or brand/shop linking
4. Search for: setup wizards, config pages, webhook handlers, shop-to-brand mapping, API key storage
5. **DIG DEEPER**: Read multiple files, trace the flow. Verify claims (e.g. "orders are created automatically") in the code before stating them. Distinguish configurable fields (user can type) from display-only fields (read-only, backend data) — only include configurable fields in setup steps. Do NOT include database table/column names in support answers.
6. If you find database tables for integration config, use search_schema + query_database to document required fields
7. **CONSIGNMENT CHECK (ESSENTIAL for POS/Shopify)**: Search for consignment requirements. For Shopify POS and similar integrations, the customer MUST typically be a consignment customer (customers.is_consignment_customer). Include this in the setup steps.
8. **NO INVENTED STEPS**: Only document steps you found in the code. Do NOT add steps from Shopify's documentation or general knowledge (e.g. "Create Special Styles", "Gift Wrap Style") unless you SAW them in SPY code. Invented menu paths mislead users.

CRITICAL: Do NOT give a narrow answer that omits essential details. The user needs the FULL setup flow from the actual codebase.
If you are unsure about a step, search for it - do not assume.

**CLARIFYING QUESTIONS:**
Feel free to ask clarifying questions whenever it would help tailor the answer (e.g. "Do you already have a Shopify shop set up?", which module, new vs existing setup, online vs POS).
`
			: '';

		// Build system prompt
		if (codeFirstDirective || databaseDirective || handlerDirective || integrationDirective) {
			const activeDirectives: string[] = [];
			if (codeFirstDirective) activeDirectives.push('CODE_FIRST');
			if (handlerDirective) activeDirectives.push('HANDLER_NAV');
			if (databaseDirective) activeDirectives.push('DATABASE_REQUIRED');
			if (integrationDirective) activeDirectives.push('INTEGRATION_COMPLETE');
			onDebugLog?.('info', 'System Prompt', `Active directives: ${activeDirectives.join(', ')}`);
		}
		let systemPrompt = `You are a helpful assistant that answers questions accurately and clearly. ALWAYS respond in the same language as the user's question.
${codeFirstDirective}${handlerDirective}${databaseDirective}${integrationDirective}

RESEARCH & THOROUGHNESS (ALWAYS — applies to EVERY question):
- The SPY codebase and database are the source of truth. Always search before answering. Do not rely on general knowledge.
- For setup, configuration, how-to, or "where do I..." questions: search the code and include ALL steps. Never skip critical details (webhooks, API keys, config screens, prerequisites, linking).
- Do not assume "obvious" steps — what is obvious in code may not be obvious to the user. Complete answers prevent follow-up frustration.
- When explaining behavior: cite the actual code path. When explaining setup: document every step you find in the code.
- If you cannot find something in the code, say so explicitly. Do not invent steps.
- **DIG DEEPER**: Quality over speed. Use multiple search_code calls, read_file on several files, trace the actual code flow. Do NOT stop at the first result — verify behavior (e.g. "automatic order creation") by reading the code before stating it. Wrong claims mislead users.

RESPONSE STYLE (CRITICAL):
- Use tools silently. Do NOT narrate your process in the answer.
- FORBIDDEN phrases (NEVER include these in your answer):
  * "Lad mig finde/se/tjekke/undersøge..."
  * "Nu har jeg fundet..."
  * "Nu kan jeg se at..."
  * "Perfekt! Nu kan jeg se..."
  * "Godt! Nu kan jeg se..."
  * "Jeg vil undersøge/søge/finde..."
  * "Jeg undersøger nu..."
  * "Jeg har fundet..."
  * Any sentence describing what YOU are doing (searching, reading, checking)
- Do NOT output thinking/reasoning text. Only output conclusions, steps, and grounded findings.
- Start directly with the answer or solution. No process narration.
- NEVER stop after a "planning" sentence. Always provide a concrete answer, or ask a clarifying question when that would lead to a better answer.

CLARIFYING QUESTIONS (use ask_clarifying_question tool — use it freely):
- You are encouraged to ask clarifying questions whenever it would help you give a better, more relevant answer. Do NOT hesitate.
- Use when: the question could mean several things; context would tailor the answer (which system, which module, online vs POS, new vs existing); you want to confirm scope before diving in; or a quick question would save the user from a long, generic answer.
- Do NOT use for: information you can look up in code/database (search_code, query_database).
- Keep the question short. Provide 2–4 clickable options when possible (e.g. ["Online shop", "POS terminal", "Both"]). Set allowFreeText: true to let users type a custom answer.
- When in doubt, ask. A focused question often leads to a much better answer than guessing.

GROUNDING & ACCURACY (CRITICAL):
- NEVER invent file paths, function names, class names, SQL queries, or UI labels.
- NEVER invent menu paths, navigation steps, or "Settings → X → Y" that you did not see in the code. If you cannot find "Settings → Integration → Shopify → Create Special Styles" (or similar) in search_code/read_file, DO NOT include it. Invented paths mislead users.
- Only claim a file/function/label exists if you saw it in tool output (search_code/read_file/describe_table/query results) during THIS run.
- If UI code search results are empty, say so and ask for the exact module/page name (English SPY UI label) or a screenshot.
- When explaining code behavior, cite the exact file path(s) you saw in tool output. If you cannot cite any file path, do NOT claim code details.
- When you use search_code, pick the best file and use read_file. Do NOT loop search_code repeatedly without reading files.
- For setup/config/how-to questions: search for each relevant area (config UI, webhooks, API setup, linking) and read the files. Thoroughness over speed.
- Prefer search_code_context for code navigation: it returns grounded excerpts with line numbers so you can answer without guessing.

NO WRITE ACTIONS (CRITICAL):
- You do NOT have permission or capability to modify code, run migrations, or apply patches to any customer system.
- You do NOT have permission or capability to execute write SQL. NEVER propose or show UPDATE/INSERT/DELETE/ALTER/DROP/CREATE/TRUNCATE/REPLACE SQL.
- NEVER ask the user to approve you running SQL or code changes (no "Should I run this?", "Shall I execute?", "Do you want me to change...").
- If a fix requires a change, explain the cause and provide a safe read-only verification (SELECT) and a suggestion to hand off to a developer/admin.

FILE ACCESS RULES (CRITICAL):
- You CAN read repository files using the read_file tool. Do NOT claim there is a "technical limitation" preventing file reads.
- If search_code returns a path, and you need details, you MUST call read_file on that path.
- If read_file fails, you MUST say the file could not be read and include the error message (e.g. file not found). Do NOT guess.
- Only ask the user for screenshots/UI URL when the question is about UI labels/placement AND you have no grounded UI code results.

TOOL SELECTION (CRITICAL - read this FIRST before doing anything):

YOU MUST USE TOOLS BEFORE ASKING QUESTIONS. Never ask the user for information you can look up yourself.

**IDENTIFIER DETECTION - SCAN THE MESSAGE FOR THESE PATTERNS:**
If ANY of these appear in the user's message, you MUST query the database IMMEDIATELY:
- Numbers that could be IDs: #12345, order 12345, return 11150, invoice 999, customer 55
- Reference numbers: "ordre 33916", "retur 11150", "faktura 999", "ordrenummer 12345"
- Named records: "customer Sofie Schnoor", "brand X", "supplier Y"
- Shopify/external refs: "Shopify order #18529", "EDI order 123"
- Module mentions with numbers: "Sales/Create order 123", "Claims/Return 11150"

When you detect an identifier → IMMEDIATELY:
1. search_schema to find the relevant table
2. query_database to get the record data
3. Then continue with any additional analysis

STEP 1: Does the question mention a specific record (order #, customer, return #, invoice)?
  YES → IMMEDIATELY query the database. Use search_schema to find the right table, then query_database.
  NO → Go to step 2.

STEP 2: Is the question about "how does X work" or "why did X happen"?
  YES → Use both: query database for the data, then search code for the logic.
  NO → Use database for data questions, code search for logic questions.

MANDATORY WORKFLOW for specific records (orders, customers, returns):
1. FIRST: Query the database for the record. DO NOT ask the user for the data.
2. THEN: If needed, search code for the business logic.
3. FINALLY: Answer with the data you found.

DATABASE FIRST (query_database) for:
- ANY number that looks like an ID (even without # prefix): "order 33916", "return 11150", "kunde 55"
- Counts, lists, statistics: "how many orders", "list all customers with..."
- Data lookups: amounts, dates, statuses, relationships, assignments
- Investigations: "why is X assigned to Y", "how was Z created", "what happened to order W"

DATABASE QUERY WORKFLOW (MANDATORY):
**NEVER guess column names.** The database will reject invalid columns. Always verify first:

1. **search_schema** first - find the correct table name
2. **get_table_schema_cached** - get the EXACT column names for that table
3. **query_database** - write SQL using ONLY columns that exist in the schema

Common SPY column naming patterns (but ALWAYS verify with schema):
- Status: "disabled" column (0=active, 1=disabled). There is NO "is_active" column!
- Type: "type" column for entity classification (e.g., 'normal', 'b2c')
- Hungarian notation: iID (int), strName (string), bActive (bool), fPrice (float)

CRITICAL BUSINESS LOGIC KNOWLEDGE:
- "Active customers" in SPY = customers WHERE disabled = 0 AND type != 'b2c'
  The Customers > Active page ALWAYS excludes B2C customers and also filters by brand access.
- "Active" for most entities means disabled = 0 (NOT a column called "active" or "is_active")
- Always check the schema FIRST because column names vary per table

CONSIGNMENT (CRITICAL - affects many areas):
- Consignment is used throughout SPY: orders, customers, stock, integrations.
- For POS integrations (Shopify POS, etc.): the customer/shop MUST be a consignment customer.
  Check customers.is_consignment_customer = true. This is often a HARD requirement.
- When answering integration setup, order flow, or customer-related questions: ALWAYS check if consignment has an impact.
- Search for: is_consignment_customer, consignment, skip_consignment, is_consignment_end_delivery.
- Do NOT omit consignment requirements. Many setups fail because the customer was not a consignment customer.

CODE SEARCH (search_code_context) for:
- "How does X work in code", "Where is the setting for Z"
- Business logic explanations (after getting the data first)
- UI navigation guidance
- Setup, configuration, how-to: search for ALL relevant parts (config forms, webhooks, API keys, linking). Give the complete picture.

FORBIDDEN BEHAVIORS:
- Do NOT ask the user for order_id, customer_id, or other data you can query yourself.
- Do NOT ask for screenshots when you can search the database and code.
- Do NOT say "I cannot give you an answer without..." - USE THE TOOLS INSTEAD.
- Do NOT ask "which database" or "which order" when there's clearly an ID in the message.
- Do NOT ask the user "where in the system" or "can you show me the code" - you have FULL ACCESS to the entire codebase via search_code, search_code_context, read_file, and list_files. USE THEM.
- Do NOT say "to confirm this, I would need to see..." - just search for it and read it yourself.
- If your first search didn't find what you need, try different search terms, file paths, or read_file on files you already found. Quality over speed — use as many searches as needed.
- Do NOT stop after one or two searches. Trace the flow: read the handler, then the service, then the queue/processor. Verify behavior in code before stating it (e.g. "orders are created automatically" — only say if you found that in the code).

PAGE/MODULE QUESTIONS (CRITICAL):
When a user asks "why does this page show X" or "why is the data different on page Y":
1. **FIRST**: search_code to find the PHP/controller for that page/module
2. **FIND THE QUERY**: Look for the SQL query or data fetching logic the page uses
3. **RUN THE SAME QUERY**: Execute a similar query to see what data the page would show
4. **COMPARE**: If user says "page shows X but I expected Y", you need to understand the page's logic first

Example - "Why does Confident/Topsellers show AW 25 instead of AW 26?":
- WRONG: Just query the database with your own logic
- RIGHT: 
  1) search_code("Topsellers" or "TopSeller") to find the controller
  2) Read the file to find how it selects the default season
  3) Query the database using the SAME logic the page uses
  4) Then explain why it shows what it shows

Example - "Why does this list show 10 items but I expected 20?":
- WRONG: Query with LIMIT 20 and say "I see 20 items"
- RIGHT:
  1) Find the page's code to see what filters/limits it applies
  2) Run a query with the SAME filters
  3) Explain why the page shows what it shows

EXAMPLES:
User: "Why is order 33916 assigned to seller Claudia?"
WRONG: "I need more information. What is the order_id?"
RIGHT: 1) search_schema for orders → 2) query order 33916 → 3) answer with data

User: "Shopify order #18529 cannot be imported"
WRONG: "Can you provide more details about the error?"
RIGHT: 1) search_schema for shopify → 2) query shopify_orders WHERE order_number=18529 → 3) check import status → 4) answer

User: "Claims/Return: Running - return no. 11150"
WRONG: "Which module are you using?"
RIGHT: 1) search_schema for returns → 2) query return 11150 with all related data → 3) answer

User: "Confident/Topsellers shows wrong season"
WRONG: Query seasons table with your own logic
RIGHT: 1) search_code("Topsellers") → 2) find the season selection code → 3) run same query → 4) explain

User: "Hvordan opsætter jeg Shopify POS i Spy og knytter den til min shop?"
WRONG: Give a high-level overview and skip webhook URLs, API keys, config tables, shop-to-brand linking, or consignment requirement
RIGHT: 1) search_code("shopify pos" or "shopify_pos") → 2) find config UI, webhook handlers, API setup → 3) read_file on each relevant file → 4) search for consignment requirement (is_consignment_customer) → 5) document ALL steps including: customer must be consignment customer, prerequisites, menus, fields, webhook registration

CODE ANALYSIS RULE:
When reading or analyzing code (from GitHub, database queries, or any source):
- ALWAYS ignore all comments in the code
- Only analyze the actual code implementation
- Comments may be outdated, misleading, or incorrect
- Base your understanding solely on what the code actually does, not what comments say it does

LARGE FILE STRATEGY:
When a file is too large and gets truncated (>500 lines):
1. DO NOT say "I cannot see the file" or "file is too large"
2. IMMEDIATELY use 'search_code' to find the specific function/class/method you need
   - Example: If looking for generateEanExcel(), use search_code("function generateEanExcel")
   - Example: If looking for a specific feature, use search_code("Size column Excel")
3. The search will show you code snippets from across the repository
4. Use those snippets to answer the question
5. Only if search fails, then ask the user for more information`;

		// Load working summary for this chat (if present)
		let workingSummaryText = '';
		try {
			const chatRecord = await chatService.getChat(chatId);
			const ws         = (chatRecord as any)?.workingSummary?.text ? String((chatRecord as any).workingSummary.text) : '';
			if (ws.trim() !== '') {
				workingSummaryText = ws.trim();
				onDebugLog?.('info', 'Working Summary', `Loaded existing summary (${workingSummaryText.length} chars)`, workingSummaryText.substring(0, 200) + (workingSummaryText.length > 200 ? '...' : ''));
			} else {
				onDebugLog?.('info', 'Working Summary', 'No existing summary for this chat');
			}
		} catch (error) {
			onDebugLog?.('error', 'Working Summary', 'Failed to load working summary', String(error));
		}

		if (workingSummaryText) {
			systemPrompt += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKING SUMMARY (CHAT MEMORY — READ THIS FIRST)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${workingSummaryText}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NOTE: Table and column names in this summary are from PREVIOUS conversation turns.
- Use them as HINTS for where to look, but ALWAYS verify with search_schema or get_table_schema_cached before writing SQL.
- Database schemas can differ between systems — never assume a table/column exists just because it is mentioned here.
- If a query fails with "table doesn't exist", the summary may be outdated — search for the correct name.
- If you find a contradiction between the summary and a tool result, ALWAYS trust the tool result.`;
		}

		// Add relevant context from vector store
		if (contextDocuments.length > 0) {
			systemPrompt += '\n\nRELEVANT SYSTEM KNOWLEDGE:\n';
			contextDocuments.forEach((doc, index) => {
				systemPrompt += `\n${index + 1}. ${doc}`;
			});
			systemPrompt += '\n\nUse this knowledge to help answer the user\'s question when relevant.';
			onDebugLog?.('info', 'Vector Store', `Added ${contextDocuments.length} documents to system prompt`);
		}

		// Add UI code grounding context (if present)
		if (uiCodeSearchSection) {
			systemPrompt += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${uiCodeSearchSection}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
		}

		// Add integration code grounding context (if integration setup question)
		if (integrationCodeSearchSection) {
			systemPrompt += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${integrationCodeSearchSection}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
		}

		if (databaseName && databaseIds.length > 0) {
			const serverDisplayName = dbServerHost.replace('.spysystem.dk', '');
			systemPrompt += `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SYSTEM CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are connected to the SPY System - a comprehensive warehouse management and e-commerce platform built with PHP 8.1 backend and React 19 frontend.

CURRENT CONNECTION:
- Database: ${databaseName}
- Database IDs:
${dbIdContext || '- (none)'}
- Server: ${serverDisplayName} (${dbServerHost})
- System: SPY Systemet
- Backend: PHP 8.1 with 100+ spysystem packages
- Frontend: React 19 with TypeScript

SYSTEM CAPABILITIES:
The SPY system handles:
- Order processing and fulfillment
- Inventory management across multiple warehouses
- Shipping integrations (DHL, UPS, FedEx, GLS, PostNord, Bring, etc.)
- E-commerce platforms (Shopify, WooCommerce, Sitoo)
- B2B operations and customer portals
- Financial tracking and accounting integrations
- EDI communication (ORDERS, DESADV, INVOIC)
- Multi-brand and multi-market support

KEY ARCHITECTURE NOTES:
- Entity-based ORM with EntityWrapper base class
- Hungarian notation (iID, strName, bActive, fPrice, arrData, oObject)
- No NULL values allowed - use 0 for "not set" integers, empty string for text
- All tables have audit fields (added_user_id, added_date, changed_user_id, changed_date)
- Collections are immutable - use withX() methods
- Prepared statements with named parameters required for all queries

SPY CODE ARCHITECTURE - PAGES vs HANDLERS vs ACTIONS:

FILE ORGANIZATION:
- Pages/views:         modules/[module-name]/index.php or view.php (full HTML page)
- Actions/handlers:    modules/[module-name]/action.php, action_*.php, or _action.php (AJAX/modal operations)
- MVC Controllers:     applications/Spy/Controller/[Namespace]/Controller.php (PHP backend)
- TS Controllers:      public/javascript/Controller/[Path]/Controller.ts (frontend logic)

CRITICAL DISTINCTION - HANDLERS ARE NOT PAGES:
- An "action" or "handler" (e.g., "action-opencustomer") is NOT a separate page.
- Actions are modal dialogs or AJAX operations that run ON TOP of a page.
- They live inside module folders alongside the page files.
- They return JSON responses or HTML fragments (not full pages).

THE data-spyaction ROUTING PATTERN:
1. HTML attribute:  data-spyaction="ActionName|event" (e.g., data-spyaction="OpenCustomer|click")
2. TS routing:      SpyController.HandleNewContent processes all data-spyaction attributes
3. Method mapping:  "OpenCustomer|click" → calls OpenCustomerAction() in the TS controller
4. AJAX call:       The TS controller method calls the PHP controller via:
                    new Get<HTMLResponseData>('Controller\\Path', 'MethodName') or
                    new Post('Controller\\Path', 'MethodName')
5. Dialog display:  PHP returns HTML → TS displays it via showDialog() (jQuery UI Dialog)
6. Re-binding:      handleNewContent($Dialog) re-binds spyaction handlers inside the new modal

ACTION FILE PATTERNS:
- action.php:       Single file with switch(mode) handling multiple actions
- action_*.php:     Dedicated file per action (e.g., action_cancel_temp_order.php)
- _action.php:      Alternative naming convention
- The "mode" URL parameter (e.g., ?mode=_DeleteOrder) determines which action runs inside the file
- Actions use anonymous classes extending BootstrapLegacyPageOrCode

SEARCH STRATEGY FOR HANDLERS/ACTIONS:
When asked about an action like "action-opencustomer" or a dialog/modal:
1. FIRST: search_code("OpenCustomerAction") in TS files to find the frontend controller method
2. THEN:  Read the TS method to find which PHP controller it calls (look for Get/Post/MVCURL)
3. THEN:  read_file on the PHP controller to understand the backend logic
4. Also:  search_code("data-spyaction=\"OpenCustomer") to find the HTML trigger

When asked about a page like "customers active":
1. search_code("modules/customers") or list_files("modules/customers") for the page files
2. Look for index.php or view.php for the page rendering
3. Look for action.php / action_*.php for related handlers

When asked about a dialog/modal:
1. search_code("showDialog") in relevant TS controller
2. Look for the Get/Post call that fetches the dialog HTML
3. Read the PHP controller method that generates the dialog content

When asked which fields a form/dialog shows:
4. Search for conditional visibility: v-if, v-show, display, isNew, isEdit, mode === 'create' vs 'edit'
5. Some fields are only in Create mode, others only in Edit mode. Document which is which.

LOCAL SCHEMA INDEX:
${schemaIndexInfo?.exists
				? `- Status: AVAILABLE\n- Generated: ${schemaIndexInfo.generatedAtIso}\n- Tables: ${schemaIndexInfo.tableCount}\n- Source: ${schemaIndexInfo.source}\n- IMPORTANT: Prefer schema-index tools (search_schema / get_table_schema_cached) with dbId for table/column discovery.`
				: `- Status: NOT AVAILABLE\n- Recommendation: Ask the user to generate it in Settings → Database Connection → Database Schema Index.\n- Until then, use describe_table with dbId when you must verify columns.`}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATABASE SECURITY & QUERY RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL SECURITY REQUIREMENT:
All database operations are READ-ONLY. You can ONLY execute SELECT, SHOW, DESCRIBE, and EXPLAIN queries.
NEVER attempt INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, or any other write operations.
Any attempt to write to the database will be blocked and result in an error.
Write operations are NEVER permitted under any circumstances.

IMPORTANT QUERY RULES:
0. When calling database tools, ALWAYS include a dbId from the CURRENT CONNECTION list above.
1. NEVER query from views that start with "bi_" (e.g., bi_orders, bi_customers, bi_sales)
   - These are BI/analytics views and should be avoided
   - Always use the actual database tables directly instead of BI views
   - If you see a table name starting with "bi_", ignore it and find the equivalent regular table

2. Common table NAME PATTERNS in SPY system (these are HINTS — verify with search_schema before use!):
   - customer: Customer data
   - orders: Order headers
   - orders_lines: Order line items
   - style: Product styles/SKUs
   - assortment: Product assortments/collections
   - packing: Warehouse packing operations
   - shipping: Shipping/delivery information
   - brand: Brand information
   - season: Season definitions
   NOTE: Actual table names may differ (e.g. "p_shipping" not "shipping"). ALWAYS search first.

3. MANDATORY TABLE VERIFICATION (prevents hallucinated table names):
   - BEFORE writing ANY SQL query, ALWAYS verify the table exists using search_schema or get_table_schema_cached
   - NEVER guess or assume table/column names — even if mentioned in conversation history or working summary
   - If you used a table 2 messages ago, you STILL must verify it exists before querying it again
   - Common mistake: inventing tables like "p_order_styles_sizes" or "shipping_details" that don't exist
   - Use search_schema with dbId to discover the correct table/column names
   - Use get_table_schema_cached with dbId to verify columns and keys before writing SQL
   - If the index is missing, ask the user to generate it in Settings → Database Connection → Database Schema Index
   - Only use describe_table with dbId when the local index is missing or looks outdated

4. CRITICAL: ALWAYS use LIMIT in your queries to control output size
   - Query results over 100 rows are AUTOMATICALLY TRUNCATED to prevent token limit errors
   - If you need more than 100 rows, use LIMIT explicitly (e.g., LIMIT 500)
   - For exploratory queries, use LIMIT 10 or LIMIT 20 to see sample data
   - Large result sets can cause "prompt too long" errors (200,000 token limit)
   - When results are truncated, you'll see a warning message with the original row count

5. Join tables explicitly - avoid implicit joins

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CSV EXPORT TOOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When the user asks for a "list", "extract", "export", "udtræk", "liste", "oversigt" or similar request for data:

1. Use the export_to_csv tool (with dbId, query, filename) to automatically create a CSV file in the Downloads folder
2. Choose a descriptive filename that reflects the data:
   - Good examples: "style_assortments_ean", "customer_orders_january", "inventory_status"
   - Bad examples: "data", "export", "results"
3. The filename should NOT include .csv extension (it's added automatically)
4. After the CSV is created, tell the user exactly where the file was saved:
   "I have created a CSV file in your Downloads folder: [filename].csv with [X] rows"
5. NEVER claim files are saved to Desktop or any other location - they are ALWAYS in the Downloads folder

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USER INTERFACE GUIDANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When users ask "how do I..." or "hvordan..." questions about performing tasks in SPY:

ALWAYS provide step-by-step UI instructions with specific button names and menu locations.

CRITICAL UI ACCURACY RULES:
- NEVER guess UI labels, button names, menu names, or field names.
- NEVER invent menu paths like "Settings → Integration → Shopify → Create Special Styles" unless you SAW that exact path in the code. If you cannot find it in search_code/read_file, omit the step or say "I could not locate this in the SPY codebase."
- If an image/screenshot is provided, quote the exact labels you can see.
- If no screenshot is provided, use code search results (if present) to ground exact labels.
- If you still cannot ground the UI labels, ask ONE clarifying question (e.g. \"Which page are you on?\" or \"Please paste a screenshot\").

SPY TERMINOLOGY (NEVER TRANSLATE):
- SPY uses English terms in the system. NEVER translate them to Danish or other languages.
- Keep these terms in English: consignment, POS, B2B, B2C, EDI, style, assortment, brand, season, shipment, packing, claim, return.
- WRONG: "konsignation" (use "consignment"), "punkt-salgs" (use "POS"), "assortiment" (use "assortment" when referring to SPY entities).
- RIGHT: "consignment-kunde", "POS-integration", "Shopify POS" — keep the SPY term in English.

**Good Example:**
"For at oprette en ny style:
1. Klik på **'Styles'** i hovedmenuen
2. Klik på **'Create New Style'** knappen i øverste højre hjørne
3. Udfyld style nummer og navn
4. Vælg brand og season
5. Klik **'Save'**"

**Bad Example:**
"Du kan oprette en style gennem systemet" (TOO VAGUE)

**Include:**
- Menu names (e.g., "Styles", "Orders", "Tools")
- Button labels (e.g., "Create New", "Save", "Export")
- Field names (e.g., "Style Number", "Customer Name")
- Navigation paths (e.g., "Settings → Users → Add User")
- Keyboard shortcuts if known (e.g., "Ctrl+S to save")
- Tab names if relevant
- Modal/dialog names

**CHECKBOXES & TOGGLES (CRITICAL):**
When describing form fields or settings:
- NEVER show raw 1 or 0 to users for boolean/checkbox/toggle values.
- Use human-readable labels: "Slået til" / "Slået fra" (Danish) or "Enabled" / "Disabled" (English).
- Match the user's language. When explaining a setting, say e.g. "Sæt til **Slået til**" not "Sæt til 1".

**CONDITIONAL FIELD VISIBILITY:**
- Forms/dialogs often show different fields for Create vs Edit. A field may exist only when editing, not when creating.
- When listing form fields, state the context: "Visible when creating" vs "Visible when editing" vs "Always visible".
- Do NOT assume all fields are visible at once. Check the code for v-if, display logic, mode checks (isNew, isEdit).
- This prevents confusion when a user says "I don't see that field" — they may be in Create mode.

**CONFIGURABLE vs DISPLAY-ONLY FIELDS (CRITICAL):**
- Before including a field in setup steps: check the code for disabled, readOnly, readonly, or display-only. If the user cannot type in it or change it, do NOT tell them to "configure" it.
- Editable fields (include in setup): API key, password, access token — when the form allows input. Shopify shop credentials, webhook URLs, etc.
- Display-only fields (omit from setup): API Key ID (internal reference), generated tokens shown for info only, IDs the user cannot edit. These are backend data for reference — the customer cannot use them.
- The same label (e.g. "API") may appear in both contexts. Check the code: is it an input or a read-only display?

**NO DATABASE STRUCTURE IN SUPPORT ANSWERS:**
- Support staff do NOT need table names, column names, or database structure. Omit these from setup/how-to answers.
- Only mention database tables/columns when the user is clearly a developer or explicitly asks for technical details.

**For technical tasks:**
- Include file paths when asked (e.g., "src/Components/StyleManager.tsx")
- Include function/class names when relevant
- Include database table names when querying

Users need concrete, actionable steps - not general descriptions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. **Summary First**: Start with a summary sentence before any details',
2. **Group Related Data**: When showing multiple items, group them logically',
3. **Use Sections with Headers**: Separate different types of data with clear headers',
4. **Tables for Structured Data**: Use markdown tables for lists of items with multiple attributes',
5. **Key Metrics Highlighted**: Put important numbers/totals in **bold**',
`;

		}

		// First, let Claude research and gather information without restrictions
		onDebugLog?.('api', 'Claude API', `Sending initial message: "${userMessage.substring(0, 100)}${userMessage.length > 100 ? '...' : ''}"`);
		if (conversationHistory && conversationHistory.length > 0) {
			onDebugLog?.('api', 'Claude API', `Including ${conversationHistory.length} messages from conversation history`);
		}
		if (contextDocuments.length > 0) {
			onDebugLog?.('api', 'Claude API', `Including ${contextDocuments.length} vector store documents in system prompt`);
		}

		const hasStreamingConsumer = typeof onEvent === 'function';

		onProgress?.('Processing response...');

		const estimatedTechnicalInputTokens = estimateTokenCount(systemPrompt) + estimateTokenCountForMessages(messages);
		onDebugLog?.(
			'info',
			'Token Usage',
			`Technical input tokens (estimated): ${estimatedTechnicalInputTokens}`,
			`systemPromptChars=${systemPrompt.length}, messages=${messages.length}`,
		);

		const technicalStartMs = Date.now();
		onDebugLog?.(
			'info',
			'TanStack AI',
			'Technical phase started',
			`messages=${messages.length}, tools=${tools.length}, systemPromptChars=${systemPrompt.length}`,
		);

		// Always use streaming for the technical phase to properly capture tool calls and text.
		// Using stream: false returns empty string when the model only produces tool calls.
		let detailedAnswer                                                                                 = '';
		let agentLoopExhausted                                                                             = false;  // true when the agent loop hit maxIterations
		let iterationCount                                                                                 = 0;
		let clarificationRequest: { question: string; options?: string[]; allowFreeText?: boolean } | null = null;
		{
			const stream = chat({
				adapter          : createAnthropicChat('claude-sonnet-4-5', apiKey),
				messages,
				tools,
				systemPrompts    : [systemPrompt],
				agentLoopStrategy: maxIterations(75),
				maxTokens        : 32_000,
				abortController,
				modelOptions     : {
					thinking: {
						type         : 'enabled',
						budget_tokens: 10_000,
					},
				},
			});

			try {
				for await (const event of stream) {
					const evt = event as any;
					if (evt.type === 'TEXT_MESSAGE_CONTENT' && typeof evt.delta === 'string') {
						detailedAnswer += evt.delta;
						// Forward text events to streaming consumer if available
						if (hasStreamingConsumer) {
							onEvent?.(evt);
						}
						continue;
					}
					if (evt.type === 'TOOL_CALL_START') {
						onProgress?.(`Running tool: ${evt.toolName || 'unknown'}`);
						onDebugLog?.('tool', 'Tool Call', `Starting tool: ${evt.toolName || 'unknown'}`);
						continue;
					}
					if (evt.type === 'TOOL_CALL_END') {
						const details = evt.result ? String(evt.result) : '';
						onDebugLog?.('tool', 'Tool Call', `Completed tool: ${evt.toolName || 'unknown'}`, details);
						// Check for clarification request (Cursor-style follow-up)
						if (evt.toolName === 'ask_clarifying_question' && evt.result) {
							const res = typeof evt.result === 'string' ? (() => {
								try {
									return JSON.parse(evt.result);
								} catch {
									return null;
								}
							})() : evt.result;
							if (res && (res as any).__clarificationRequest) {
								clarificationRequest = {
									question     : (res as any).question,
									options      : (res as any).options,
									allowFreeText: (res as any).allowFreeText !== false,
								};
								onDebugLog?.('info', 'Clarification', 'AI requested clarification, returning early');
								break;
							}
						}
						continue;
					}
					if (evt.type === 'STEP_STARTED') {
						onDebugLog?.('info', 'Claude Thinking', `Thinking step started (type: ${evt.stepType || 'unknown'})`);
						continue;
					}
					if (evt.type === 'STEP_FINISHED') {
						const thinkingPreview = typeof evt.content === 'string' ? evt.content.substring(0, 200) : '';
						onDebugLog?.('info', 'Claude Thinking', `Thinking step finished (${thinkingPreview.length} chars)`, thinkingPreview);
						continue;
					}
					if (evt.type === 'RUN_STARTED') {
						iterationCount++;
						onDebugLog?.('info', 'Claude API', `Agent loop iteration ${iterationCount} started`);
						continue;
					}
					if (evt.type === 'RUN_FINISHED') {
						const reason = evt.finishReason || 'unknown';
						onDebugLog?.('info', 'Claude API', `Agent loop finished (reason: ${reason}, iterations: ${iterationCount})`);
						// Detect if the agent loop was exhausted (hit maxIterations)
						if (reason === 'max_turns' || reason === 'maxIterations' || reason === 'max_iterations') {
							agentLoopExhausted = true;
							onDebugLog?.('info', 'Claude API', 'Agent loop EXHAUSTED max iterations — will run completion step');
						}
						continue;
					}
					if (evt.type === 'RUN_ERROR') {
						const errorMsg = evt.error?.message ? String(evt.error.message) : 'Unknown error';
						onDebugLog?.('error', 'Claude API', 'Run error', errorMsg);
					}
				}
			} catch (error) {
				onDebugLog?.('error', 'Claude API', 'Stream failed', String(error));
				throw error;
			}

			detailedAnswer = detailedAnswer.trim();
			onDebugLog?.('info', 'Technical Response', `Streaming complete, text length: ${detailedAnswer.length}, iterations: ${iterationCount}, exhausted: ${agentLoopExhausted}`);
		}

		// Early return if AI asked for clarification (Cursor-style follow-up)
		if (clarificationRequest) {
			return {
				needsClarification: true,
				question          : clarificationRequest.question,
				options           : clarificationRequest.options,
				allowFreeText     : clarificationRequest.allowFreeText !== false,
			};
		}

		detailedAnswer = sanitizeAssistantAnswer(detailedAnswer);

		// ── Completion guarantee ──────────────────────────────────────────────────
		// When the agent loop was exhausted (hit maxIterations) or the answer is
		// clearly mid-investigation, give Claude one final chance to wrap up with
		// all the data it has gathered so far.
		const looksIncomplete = agentLoopExhausted || looksLikeMidInvestigation(detailedAnswer);
		if (looksIncomplete && queryResults.length > 0) {
			onDebugLog?.('info', 'Completion Guarantee', `Answer looks incomplete (exhausted=${agentLoopExhausted}, midInvestigation=${looksLikeMidInvestigation(detailedAnswer)}). Running completion step with ${queryResults.length} query results.`);
			onProgress?.('Finishing analysis...');

			try {
				// Build a compact summary of ALL query results gathered during the investigation
				const queryDataSummary = queryResults.map((qr, i) => {
					const preview = qr.data.length > 10
						? JSON.stringify(qr.data.slice(0, 10)) + `\n... (${qr.data.length} rows total)`
						: JSON.stringify(qr.data);
					return `Query ${i + 1}: ${qr.query}\nRows: ${qr.data.length}\nData: ${preview}`;
				}).join('\n\n');

				const completionPrompt = `You were in the middle of investigating a question but ran out of steps.

Here is everything you found so far. USE THIS DATA to provide a COMPLETE, CONCLUSIVE answer.

ORIGINAL QUESTION:
${userMessage}

YOUR INVESTIGATION SO FAR:
${detailedAnswer.length > 3000 ? detailedAnswer.substring(detailedAnswer.length - 3000) : detailedAnswer}

ALL DATABASE QUERY RESULTS YOU OBTAINED (${queryResults.length} queries):
${queryDataSummary}

RULES:
- Answer in the SAME LANGUAGE as the user's question.
- Provide a COMPLETE answer based on the data above.
- Include specific numbers from the query results.
- Do NOT say you need more data — use what you have.
- Do NOT narrate your process. Just give the answer.
- If some queries returned empty results, mention what was NOT found.
- If you can draw a conclusion from the data, do so clearly.`;

				let completionText     = '';
				const completionStream = chat({
					adapter          : createAnthropicChat('claude-sonnet-4-5', apiKey),
					messages         : [...messages, {role: 'assistant', content: detailedAnswer}, {role: 'user', content: completionPrompt}],
					tools,
					systemPrompts    : [systemPrompt],
					agentLoopStrategy: maxIterations(10),
					maxTokens        : 16_000,
					abortController,
				});
				for await (const event of completionStream) {
					const evt = event as any;
					if (evt.type === 'TEXT_MESSAGE_CONTENT' && typeof evt.delta === 'string') {
						completionText += evt.delta;
					}
				}
				const completed = sanitizeAssistantAnswer(completionText.trim());
				if (completed && completed.length > 50) {
					// Append the completion to the detailed answer so the full investigation is preserved
					detailedAnswer = sanitizeAssistantAnswer(`${detailedAnswer}\n\n${completed}`);
					onDebugLog?.('info', 'Completion Guarantee', `Completion step produced ${completed.length} chars`);
				} else {
					onDebugLog?.('info', 'Completion Guarantee', 'Completion step produced insufficient output — keeping original');
				}
			} catch (error) {
				onDebugLog?.('error', 'Completion Guarantee', 'Completion step failed', String(error));
			}
		}

		// Also check if the question required database but no queries were executed.
		// EXCEPTION: Integration setup questions are answered from CODE; database is optional (schema/config examples).
		// Forcing a DB retry on integration setup can cause poor retry output (e.g. "Jeg vil undersøge...") and lose the good code-based answer.
		const requiredDatabaseButNoQueries = requiresDatabase && queryResults.length === 0 && !requiresIntegrationFocus;
		if (requiredDatabaseButNoQueries) {
			onDebugLog?.('info', 'Claude API', 'Question required database but no queries were made - forcing retry with database tools');
		}

		if (isNonAnswer(detailedAnswer) || requiredDatabaseButNoQueries) {
			// Reset search counter so the retry gets fresh search quota
			resetSearchCounter();
			onDebugLog?.('info', 'Claude API', 'Technical answer was non-responsive; retrying with stricter answer request (search counter reset)');
			try {
				// Include the query results in the retry prompt so the model knows what data it found
				const queryResultsSummary = queryResults.length > 0
					? `\n\nYou already executed these queries and got results:\n${queryResults.slice(0, 5).map((qr, i) => `${i + 1}. Query: ${qr.query.substring(0, 100)}...\n   Result: ${qr.data.length} rows`).join('\n')}\n\nUSE THIS DATA to answer. Do NOT say you need to query - you already did.`
					: '';

				// If no queries were made but database is required, force tool use
				const forceToolUseDirective = requiredDatabaseButNoQueries
					? `

**CRITICAL ERROR: You did NOT use database tools.** This question REQUIRES database access.
You MUST:
1. Use search_schema to find relevant tables (e.g., users, customers, orders)
2. Use query_database to get the actual data
3. Include the query results in your answer

DO NOT ANSWER WITHOUT QUERYING THE DATABASE FIRST.`
					: '';

				const retryMessages: ChatMessage[] = [
					...messages,
					{
						role   : 'user',
						content: `Your previous answer was not useful.${forceToolUseDirective}${queryResultsSummary}

RULES:
- Answer in the SAME LANGUAGE as the user's question.
- Do NOT narrate your process.
- Use the data from your tool calls to answer the question directly.
- Do NOT say "I cannot answer without..." - use the database tools NOW.
- Do NOT ask for order_id, database ID, or other information you can query.

${requiredDatabaseButNoQueries ? 'USE get_table_schema_cached AND query_database NOW, THEN provide the answer with the REAL numbers from the query.' : 'PROVIDE THE FINAL ANSWER NOW using the data you found.'}`,
					},
				];

				// Use streaming to properly capture tool calls and text
				let retryText     = '';
				const retryStream = chat({
					adapter          : createAnthropicChat('claude-sonnet-4-5', apiKey),
					messages         : retryMessages,
					tools,
					systemPrompts    : [systemPrompt],
					agentLoopStrategy: maxIterations(6),
					maxTokens        : 32_000,
					abortController,
				});
				for await (const event of retryStream) {
					const evt = event as any;
					if (evt.type === 'TEXT_MESSAGE_CONTENT' && typeof evt.delta === 'string') {
						retryText += evt.delta;
					}
				}
				const retried = sanitizeAssistantAnswer(retryText.trim());
				onDebugLog?.('info', 'Technical Retry', `Streaming complete, text length: ${retried?.length || 0}`);
				// Don't replace a substantial answer with a very short retry (e.g. "Jeg vil undersøge...")
				if (retried) {
					if (retried.length < 150 && detailedAnswer.length > 500) {
						onDebugLog?.('info', 'Technical Retry', `Retry too short (${retried.length} chars); keeping original (${detailedAnswer.length} chars)`);
					} else {
						detailedAnswer = retried;
					}
				}
			} catch (error) {
				onDebugLog?.('error', 'Claude API', 'Technical retry failed', String(error));
			}
		}
		if (looksTruncatedAnswer(detailedAnswer)) {
			onDebugLog?.('info', 'Claude API', 'Technical answer looks truncated; requesting continuation');
			try {
				const tail = detailedAnswer.slice(Math.max(0, detailedAnswer.length - 1800));

				// Include query results so the continuation can reference actual data
				const queryContext = queryResults.length > 0
					? `\n\nDatabase query results available:\n${queryResults.slice(0, 8).map((qr, i) => `${i + 1}. ${qr.query.substring(0, 120)} → ${qr.data.length} rows`).join('\n')}`
					: '';

				const continuationPrompt = `Continue the answer below. The answer was cut off mid-sentence.

Rules:
- Answer in the SAME LANGUAGE as the user's question.
- Do NOT repeat earlier content.
- Start by completing the last unfinished sentence fragment.
- Output ONLY the continuation text (no intro).
- Use the data context below to provide a conclusive answer.

User question:
${userMessage}
${queryContext}

Answer so far (truncated):
${tail}`;

				const continuationResponse = await runChatWithMaxTokensFallback(
					chat,
					{
						adapter  : createAnthropicChat('claude-sonnet-4-5', apiKey),
						messages : [{role: 'user', content: continuationPrompt}],
						maxTokens: 8000,
						stream   : false,
					},
					{onDebugLog, label: 'Technical continuation'},
				);
				const continuationText     = sanitizeAssistantAnswer(await extractTextFromChatResponse(continuationResponse, onDebugLog, 'Technical Continuation'));
				if (continuationText) {
					detailedAnswer = sanitizeAssistantAnswer(`${detailedAnswer}\n${continuationText}`);
				}
			} catch (error) {
				onDebugLog?.('error', 'Claude API', 'Continuation request failed', String(error));
			}
		}

		const estimatedTechnicalOutputTokens = estimateTokenCount(detailedAnswer);
		onDebugLog?.(
			'info',
			'Token Usage',
			`Technical output tokens (estimated): ${estimatedTechnicalOutputTokens}`,
			`detailedChars=${detailedAnswer.length}`,
		);

		onDebugLog?.(
			'info',
			'TanStack AI',
			`Technical phase completed in ${Date.now() - technicalStartMs} ms`,
			`detailedChars=${detailedAnswer.length}`,
		);
		// Auto-export CSV if user requested a list/export
		const exportKeywords  = ['list', 'liste', 'udtræk', 'export', 'eksporter', 'overview', 'oversigt'];
		const isExportRequest = exportKeywords.some((keyword) => userMessage.toLowerCase().includes(keyword));
		if (isExportRequest && queryResults.length > 0) {
			// Find the largest query result (most likely the main data they want)
			const largestResult = queryResults.reduce((prev, current) =>
				(current.data.length > prev.data.length) ? current : prev,
			);

			// Only export if it has at least 10 rows (avoid exporting metadata queries)
			if (largestResult.data.length >= 10) {
				onProgress?.(`Auto-generating CSV export with ${largestResult.data.length} rows...`);

				// Generate unique filename with timestamp
				const now      = new Date();
				const dateStr  = now.toISOString().split('T')[0]; // YYYY-MM-DD
				const timeStr  = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
				const filename = `export_${dateStr}_${timeStr}.csv`;

				try {
					await exportToCsvFile(filename, largestResult.data);

					const currentText = detailedAnswer;
					messages.push({
						role   : 'assistant',
						content: currentText,
					});

					messages.push({
						role   : 'user',
						content: `A CSV file has been automatically created: ${filename} with ${largestResult.data.length} rows saved to the Downloads folder. Include this information in your answer.`,
					});

					const updatedAnswer = await chat({
						adapter: createAnthropicChat('claude-sonnet-4-5', apiKey),
						messages,
						stream : false,
					});

					detailedAnswer = sanitizeAssistantAnswer(await extractTextFromChatResponse(updatedAnswer, onDebugLog, 'CSV Export Update'));
				} catch (error) {
					console.error('[ClaudeService] Failed to auto-export CSV:', error);
				}
			}
		}
		onProgress?.('Finishing answer...');

		// Only add the technical answer if it's not empty
		if (!detailedAnswer) {
			// If Claude didn't provide a text response (only used tools), ask for an answer
			// Include query results so it doesn't hallucinate numbers
			const queryDataForAnswer = queryResults.length > 0
				? `\n\nDatabase query results you obtained:\n${queryResults.map((qr, i) => `${i + 1}. Query: ${qr.query}\n   Rows: ${qr.data.length}\n   Data: ${JSON.stringify(qr.data.slice(0, 5))}`).join('\n')}\n\nUse ONLY these actual numbers in your answer. Do NOT make up numbers.`
				: '\n\nWARNING: No database queries were executed. You MUST use the query_database tool to get real data before answering. NEVER make up numbers.';

			messages.push({
				role   : 'user',
				content: `Provide a complete answer in the SAME LANGUAGE as the original question.${queryDataForAnswer}

CRITICAL: Every number in your answer MUST come from an actual database query result. If you have no query results, use the database tools NOW to get real data.`,
			});

			onDebugLog?.('info', 'Claude API', `Tool-only answer phase: ${queryResults.length} query results available`);

			// Use streaming with tools so it can still query if needed
			let toolOnlyText     = '';
			const toolOnlyStream = chat({
				adapter          : createAnthropicChat('claude-sonnet-4-5', apiKey),
				messages,
				tools,
				systemPrompts    : [systemPrompt],
				agentLoopStrategy: maxIterations(6),
			});
			for await (const event of toolOnlyStream) {
				const evt = event as any;
				if (evt.type === 'TEXT_MESSAGE_CONTENT' && typeof evt.delta === 'string') {
					toolOnlyText += evt.delta;
				}
			}
			detailedAnswer = sanitizeAssistantAnswer(toolOnlyText.trim());
			onDebugLog?.('info', 'Tool-only Answer', `Streaming complete, text length: ${detailedAnswer?.length || 0}`);
		}

		// Start a fresh conversation for the simplification step (no history).
		// IMPORTANT: We intentionally do NOT include conversationHistory here.
		// Reason: For follow-up questions, history can cause the model to rewrite/summarize an older assistant message.
		const desiredDetailLevel = detectDesiredDetailLevel(userMessage);
		const detailedLinesCount = detailedAnswer ? detailedAnswer.split('\n').filter((l) => l.trim() !== '').length : 0;

		// If the technical answer is already short, return it directly as the short answer.
		// This avoids awkward "rewrites" that can remove important nuance.
		const isAlreadyShort = detailedLinesCount > 0 && detailedLinesCount <= 4 && detailedAnswer.length <= 700;
		if (!hasStreamingConsumer && isAlreadyShort && desiredDetailLevel === 'short') {
			onProgress?.('Finalizing answer...');
			return {
				shortAnswer   : detailedAnswer,
				detailedAnswer: detailedAnswer,
			};
		}

		// If the technical answer is already a complete step-by-step guide (multiple sections, structured),
		// skip simplification to avoid duplication. The simplification model sometimes outputs the guide twice.
		const headerCount            = (detailedAnswer.match(/^#{1,4}\s/gm) || []).length;
		const isAlreadyCompleteGuide = detailedAnswer.length >= 1200 && headerCount >= 2 && detailedLinesCount >= 15;
		if (!hasStreamingConsumer && isAlreadyCompleteGuide) {
			onProgress?.('Finalizing answer...');
			return {
				shortAnswer   : detailedAnswer,
				detailedAnswer: detailedAnswer,
			};
		}

		const lengthRule = desiredDetailLevel === 'detailed'
			? `OUTPUT LENGTH:
- Write as much as needed (up to ~25 lines) to fully explain the answer.
- Use sections and bullets for clarity.`
			: desiredDetailLevel === 'medium'
				? `OUTPUT LENGTH:
- Aim for ~5-12 lines. Use bullets to keep it scannable.`
				: `OUTPUT LENGTH:
- Be concise but COMPLETE. Aim for ~3-12 lines.
- If the topic requires explanation (e.g., comparing two features, explaining a bug), use as many lines as needed to be clear. Never sacrifice clarity for brevity.
- Simple factual answers (counts, statuses, yes/no) can be 1-3 lines.
- NEVER cram multiple pieces of information into a single long paragraph. Split into multiple short paragraphs or bullets instead.`;

		const simplificationPrompt = `You will rewrite a technical assistant answer for customer support staff who work with the SPY system daily.

TONE & STYLE:
- Write like a knowledgeable colleague explaining something over coffee - professional, clear, and direct.
- The readers are smart people who know the SPY system well, but they are NOT programmers.
- Do NOT dumb things down or be condescending. Do NOT over-explain obvious things.
- DO explain the "why" when it matters - they want to understand the logic, not just get a number.
- Use natural language. Avoid bullet-point overload for simple answers.
- When comparing two features or explaining a difference, structure it clearly so the reader immediately sees what's different and why.

CRITICAL RULES:
- Answer in the SAME LANGUAGE as the user's question.
- Rewrite ONLY the "LATEST TECHNICAL ANSWER" provided below.
- Do NOT summarize or rewrite any earlier conversation.
- Keep the meaning and correctness. Do NOT invent details.
- If the technical answer found no results, say so honestly. Do NOT fabricate.
- NEVER include or propose write SQL. NEVER ask to "run" anything.
- **NO DUPLICATION**: Output ONE coherent answer. NEVER output a summary/header followed by the full content again. If the technical answer is already a complete step-by-step guide, either keep it as-is (with minor formatting) or condense it - but do NOT repeat the full guide twice.

${lengthRule}

FORMATTING (use markdown actively to make the answer scannable and readable):
- **Bold** for key terms, labels, and important values
- Bullets or numbered lists for lists of 2+ items
- \`backticks\` for file names, function names, table names, column names
- Break the answer into SHORT paragraphs (1-3 sentences each). NEVER write one giant block of text.
- Use blank lines between paragraphs generously - whitespace improves readability.
- Use headers (## or ###) when the answer covers multiple topics or sections.
- For data with multiple fields (e.g., order details, customer info), use a structured format (bullets or a small table) instead of embedding everything in a sentence.

GOOD EXAMPLES:

Example 1 (simple count):
"I SPY er der **95 aktive kunder**. Det er kunder der ikke er deaktiverede og ikke er B2C-kunder."

Example 2 (explaining a difference):
"**Style Details** filtrerer styles med inaktive leveringer fra, via parameteren \`bOnlyTakeRunning\` i \`salesOrders::GetStyleDetailsTable()\`.

**Styles - List** gør det ikke - den viser alle styles uanset leveringsstatus.

Så forskellen er bevidst: Style Details giver et "renere" billede af aktive leveringer, mens Styles - List giver det fulde overblik."

Example 3 (investigation):
"Ordre **#12345** er fastlåst i status *Processing* fordi der mangler lagerallokering på 2 linjer. Linjerne refererer til varer der er udgået af \`products\`-tabellen."

BAD EXAMPLES (avoid these):
- "Baseret på min undersøgelse af systemet..." (process narration)
- "Ifølge databasen..." (mentions internal tools)
- "Du har 95 aktive kunder 😊" (emojis, too casual)
- "Der er desværre ramt en søgegrænse..." (internal limitations)

CONTENT RULES:
- SPY UI is in English. Always use exact English UI labels (menus, buttons, tabs, fields).
- NEVER translate SPY terms: use "consignment" not "konsignation", "POS" not "punkt-salgs", "assortment" not "assortiment" when referring to SPY entities.
- For checkboxes/toggles: use "Slået til" / "Slået fra" (Danish) or "Enabled" / "Disabled" (English).
  NEVER show raw 1 or 0 to users for boolean/checkbox values.
- If they ask for file/code locations, include them directly - don't hide technical info.
- If a CSV file was created, mention the file name and location.
- NEVER describe your process or mention tools/databases/vector stores.
- Start directly with the answer. No prefaces.
- REMOVE database structure (table names, column names) from support answers — support staff do not need it.
- REMOVE display-only fields (read-only, backend reference) from setup steps — only include fields the user can actually configure. Keep API key/credentials when they are editable inputs.

INPUTS:
LATEST USER QUESTION:
${userMessage}

LATEST TECHNICAL ANSWER:
${detailedAnswer}`;

		const simplificationMessages: ChatMessage[] = [
			{
				role   : 'user',
				content: simplificationPrompt,
			},
		];

		const estimatedSimplificationInputTokens = estimateTokenCount(simplificationPrompt);
		onDebugLog?.(
			'info',
			'Token Usage',
			`Simplification input tokens (estimated): ${estimatedSimplificationInputTokens}`,
			`promptChars=${simplificationPrompt.length}`,
		);

		// Get the simplified response (no tools needed here, CSV already created)
		let simplifiedText          = '';
		const simplificationStartMs = Date.now();
		onDebugLog?.('info', 'TanStack AI', 'Simplification phase started');
		if (hasStreamingConsumer) {
			const simplifiedStream = chat({
				adapter  : createAnthropicChat('claude-sonnet-4-5', apiKey),
				messages : simplificationMessages,
				maxTokens: 20_000,
				abortController,
			});

			try {
				for await (const event of simplifiedStream) {
					const evt = event as any;
					onEvent?.(evt);
					if (evt.type === 'TEXT_MESSAGE_CONTENT' && typeof evt.delta === 'string') {
						simplifiedText += evt.delta;
					}
				}
			} catch (error) {
				onDebugLog?.('error', 'Claude API', 'Simplification stream failed', String(error));
				throw error;
			}
		} else {
			const simplifiedResponse = await runChatWithMaxTokensFallback(
				chat,
				{
					adapter  : createAnthropicChat('claude-sonnet-4-5', apiKey),
					messages : simplificationMessages,
					maxTokens: 20_000,
					stream   : false,
				},
				{onDebugLog, label: 'Simplification phase'},
			);
			simplifiedText           = await extractTextFromChatResponse(simplifiedResponse, onDebugLog, 'Simplification');
		}

		onProgress?.('Finalizing answer...');

		// Check if simplified answer looks truncated and request continuation if needed.
		// NOTE: Do NOT use a length threshold (e.g. < 200) here — short but complete answers
		// (like simple counts) are perfectly valid and must not trigger a continuation request.
		if (looksTruncatedAnswer(simplifiedText)) {
			onDebugLog?.('info', 'Claude API', 'Simplified answer looks truncated; requesting continuation');
			try {
				const tail                                                                         = simplifiedText.slice(Math.max(0, simplifiedText.length - 800));
				const continuationPrompt                                                           = `The previous response was cut off mid-sentence. Here is the ending:\n\n"${tail}"\n\nPlease continue EXACTLY where it stopped and finish the answer. Do NOT repeat content. Only output the missing continuation. If the answer is already complete, respond with exactly: COMPLETE`;
				const continuationMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [
					...simplificationMessages,
					{role: 'assistant' as const, content: simplifiedText},
					{role: 'user' as const, content: continuationPrompt},
				];
				const continuationResponse                                                         = await runChatWithMaxTokensFallback(
					chat,
					{
						adapter  : createAnthropicChat('claude-sonnet-4-5', apiKey),
						messages : continuationMessages,
						maxTokens: 32_000,
						stream   : false,
					},
					{onDebugLog, label: 'Simplification continuation'},
				);
				const continuationText                                                             = await extractTextFromChatResponse(continuationResponse, onDebugLog, 'Simplification Continuation');
				// Only append if the continuation is actual content, not a "the answer is complete" meta-response.
				if (continuationText && !looksLikeNonContinuation(continuationText)) {
					simplifiedText = simplifiedText + continuationText;
				} else {
					onDebugLog?.('info', 'Claude API', 'Continuation was empty or indicated answer is already complete - skipping');
				}
			} catch (error) {
				onDebugLog?.('error', 'Claude API', 'Simplification continuation failed', String(error));
			}
		}

		// Extract simplified answer (we will also update working summary).
		simplifiedText = sanitizeAssistantAnswer(simplifiedText);
		if (!simplifiedText) {
			simplifiedText = 'Jeg kan hjælpe med NemEDI, men jeg mangler lidt kontekst. Hvilken del er det I vil bruge (opsætning, ordrer, forsendelser, faktura, eller fejlmeddelelser)?';
		}

		const estimatedSimplificationOutputTokens = estimateTokenCount(simplifiedText);
		onDebugLog?.(
			'info',
			'Token Usage',
			`Simplification output tokens (estimated): ${estimatedSimplificationOutputTokens}`,
			`simplifiedChars=${simplifiedText.length}`,
		);

		const estimatedTotalTokens = estimatedTechnicalInputTokens
			+ estimatedTechnicalOutputTokens
			+ estimatedSimplificationInputTokens
			+ estimatedSimplificationOutputTokens;
		onDebugLog?.(
			'info',
			'Token Usage',
			`Total tokens (estimated): ${estimatedTotalTokens}`,
			`technical=${estimatedTechnicalInputTokens + estimatedTechnicalOutputTokens}, simplification=${estimatedSimplificationInputTokens + estimatedSimplificationOutputTokens}`,
		);

		onDebugLog?.(
			'info',
			'TanStack AI',
			`Simplification phase completed in ${Date.now() - simplificationStartMs} ms`,
			`simplifiedChars=${simplifiedText.length}`,
		);

		// Generate an AI title in the background (best-effort).
		let suggestedTitle: string | undefined;
		try {
			const chatRecord           = await chatService.getChat(chatId);
			const systemName           = (chatRecord?.systemName || '').trim();
			const databaseNameForTitle = (chatRecord?.databaseName || '').trim();
			const context              = systemName || databaseNameForTitle ? `Context:\n- System: ${systemName || '(none)'}\n- Database: ${databaseNameForTitle || '(none)'}\n` : '';

			const titlePrompt = `Create a short chat title in Danish.\n\nCRITICAL RULES:\n- Output ONLY the title text (no quotes, no prefix, no markdown)\n- 3 to 6 words\n- Must describe the topic (what this chat is about)\n- Avoid filler and function words (no "jeg", "mig", "hjælp", "kan", "vil", "skal", "blevet", "dannet")\n- Prefer concrete nouns + identifiers (return/order numbers, module name, integration name)\n- Use the exact English SPY UI labels if you mention menus/modules/buttons\n\nGood examples:\n- Return 11150 – Shopify webhook\n- NemEDI opsætning og fejlsøgning\n- Claims/Return: Spor oprettelse\n\nBad examples:\n- Sofie Schnoor - dannet blevet hjælpe jeg\n- Jeg vil hjælpe med...\n\n${context}\nLatest user message:\n${userMessage}\n\nAssistant answer:\n${simplifiedText}`;

			// Use Haiku for fast title generation - fallback to Sonnet if empty/error
			let raw = '';
			try {
				const titleResponse = await chat({
					adapter  : createAnthropicChat('claude-haiku-4-5', apiKey),
					messages : [{role: 'user', content: titlePrompt}],
					maxTokens: 100,
				});
				raw                 = await extractTextFromChatResponse(titleResponse, onDebugLog, 'Chat Title (Haiku)');
			} catch (titleError) {
				onDebugLog?.('error', 'Chat Title', `Haiku model error: ${titleError instanceof Error ? titleError.message : String(titleError)}`);
			}

			// If Haiku failed (RUN_ERROR or empty), retry with Sonnet
			if (!raw || raw.length === 0) {
				onDebugLog?.('info', 'Chat Title', 'Haiku returned empty, retrying with Sonnet...');
				try {
					const sonnetResponse = await chat({
						adapter  : createAnthropicChat('claude-sonnet-4-5', apiKey),
						messages : [{role: 'user', content: titlePrompt}],
						maxTokens: 100,
					});
					raw                  = await extractTextFromChatResponse(sonnetResponse, onDebugLog, 'Chat Title (Sonnet fallback)');
				} catch (sonnetError) {
					onDebugLog?.('error', 'Chat Title', `Sonnet fallback also failed: ${sonnetError instanceof Error ? sonnetError.message : String(sonnetError)}`);
				}
			}

			const candidate = normalizeTitleCandidate(raw);
			if (isValidTitleCandidate(candidate)) {
				suggestedTitle = candidate.length > 60 ? `${candidate.substring(0, 57)}...` : candidate;
			} else {
				const fallback = generateFallbackTitle({
					userMessage,
					assistantAnswer: simplifiedText,
					systemName,
				});
				if (fallback) {
					onDebugLog?.('info', 'Chat Title', 'AI title rejected; using fallback', `raw="${raw}" fallback="${fallback}"`);
					suggestedTitle = fallback;
				} else {
					onDebugLog?.('info', 'Chat Title', 'AI title rejected; no fallback available', `raw="${raw}"`);
				}
			}
		} catch (error) {
			onDebugLog?.('error', 'Chat Title', 'Failed to generate AI title', String(error));
		}

		// Update working summary in the background (best-effort).
		// Feed the DETAILED answer (contains SQL, tables, schemas) so the summary
		// captures technical context for future turns.
		try {
			onDebugLog?.('info', 'Working Summary', 'Generating updated summary...');
			const detailedExcerpt = detailedAnswer && detailedAnswer.length > 3000
				? detailedAnswer.substring(0, 3000) + '\n[...truncated...]'
				: (detailedAnswer || simplifiedText);

			const updatePrompt = `You are maintaining a concise "working summary" for an ongoing database support chat.
Your goal is to preserve enough context so the AI assistant can continue the conversation without losing track of tables, schemas, or previous findings.

Update the existing summary using the latest exchange below.

REQUIRED SECTIONS (use these exact headers):

## Confirmed Facts
- Key findings, numbers, and answers established so far (max 8 bullets)

## Database Context
- Tables used (with key columns discovered), e.g.: "customers (id, name, type, disabled)"
- Successful SQL patterns and JOINs that worked
- Database name and any schema specifics noted
- Important column meanings discovered (e.g. "disabled=0 means active")

## Current Topic
- What the user is currently investigating (1-2 bullets)

## Open Questions
- Unresolved questions or things to follow up on (max 3 bullets)

RULES:
- Output plain text only (no JSON, no code fences)
- Max 20 bullet points total across all sections
- Remove outdated points
- Keep table/column names EXACT (they are case-sensitive)
- If the assistant ran SQL queries, extract the table names and key columns used

Existing summary:
${workingSummaryText || '(none)'}

Latest user message:
${userMessage}

Assistant technical answer:
${detailedExcerpt}`;

			// Use Haiku for fast summary generation - fallback to Sonnet if empty/error
			let summaryText = '';
			try {
				const summaryResponse = await chat({
					adapter  : createAnthropicChat('claude-haiku-4-5', apiKey),
					messages : [{role: 'user', content: updatePrompt}],
					maxTokens: 1500,
				});
				summaryText           = await extractTextFromChatResponse(summaryResponse, onDebugLog, 'Working Summary (Haiku)');
			} catch (summaryError) {
				onDebugLog?.('error', 'Working Summary', `Haiku model error: ${summaryError instanceof Error ? summaryError.message : String(summaryError)}`);
			}

			// If Haiku failed (RUN_ERROR or empty), retry with Sonnet
			if (!summaryText || summaryText.length === 0) {
				onDebugLog?.('info', 'Working Summary', 'Haiku returned empty, retrying with Sonnet...');
				try {
					const sonnetResponse = await chat({
						adapter  : createAnthropicChat('claude-sonnet-4-5', apiKey),
						messages : [{role: 'user', content: updatePrompt}],
						maxTokens: 1500,
					});
					summaryText          = await extractTextFromChatResponse(sonnetResponse, onDebugLog, 'Working Summary (Sonnet fallback)');
				} catch (sonnetError) {
					onDebugLog?.('error', 'Working Summary', `Sonnet fallback also failed: ${sonnetError instanceof Error ? sonnetError.message : String(sonnetError)}`);
				}
			}
			onDebugLog?.('info', 'Working Summary', `Extracted text length: ${summaryText?.length || 0}`);

			if (summaryText && summaryText.trim().length > 0) {
				await chatService.setWorkingSummary(chatId, summaryText);
				onDebugLog?.('info', 'Working Summary', 'Updated working summary', summaryText.substring(0, 300) + (summaryText.length > 300 ? '...' : ''));
			} else {
				onDebugLog?.('info', 'Working Summary', 'Summary generation returned empty text - not updating');
			}
		} catch (error) {
			onDebugLog?.('error', 'Working Summary', 'Failed to update working summary', String(error));
		}

		return {
			shortAnswer: simplifiedText,
			detailedAnswer,
			suggestedTitle,
		};
	}
}

function stripProcessLeadSentences(text: string): string {
	let out = (text || '').trim();
	if (!out) {
		return '';
	}

	// Normalize missing space after sentence end ("...oprettet.Det" -> "...oprettet. Det")
	out = out.replace(/([.!?])([A-ZÆØÅ])/g, '$1 $2');

	const sentencePatterns: RegExp[] = [
		/^\s*jeg\s+(?:vil\s+)?(?:gerne\s+)?hjælp\w*[^.?!]*[.?!]\s*/i,
		/^\s*jeg\s+hjælper[^.?!]*[.?!]\s*/i,
		/^\s*jeg\s+(?:vil\s+)?(?:først\s+)?(?:undersøg\w*|tjek\w*|kig\w*|find\w*|søge\w*)[^.?!]*[.?!]\s*/i,
		/^\s*lad\s+mig[^.?!]*[.?!]\s*/i,
		/^\s*nu\s+kan\s+jeg\s+se[^.?!]*[.?!]\s*/i,
	];

	// Remove multiple leading "process" sentences if present.
	for (let i = 0; i < 8; i++) {
		const before = out;
		for (const re of sentencePatterns) {
			out = out.replace(re, '');
		}
		out = out.trim();
		if (out === before.trim()) {
			break;
		}
	}

	return out.trim();
}

function stripThinkingBlocks(text: string): string {
	let cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
	cleaned     = cleaned.replace(/^\s*(thinking|reasoning|analysis)\s*:\s*.*$/gmi, '');
	cleaned     = cleaned.replace(/^\s*\[thinking\].*$/gmi, '');
	return cleaned.trim();
}

function sanitizeAssistantAnswer(text: string): string {
	const original = (text || '').trim();
	if (!original) {
		return '';
	}

	// 1) Remove explicit thinking tags/blocks.
	const withoutThinking = stripThinkingBlocks(original);

	// 2) Remove leading "process" sentences.
	let stripped = stripProcessLeadSentences(withoutThinking);

	// 3) Remove standalone process paragraphs anywhere (e.g. "Lad mig ...:").
	stripped = stripStandaloneProcessParagraphs(stripped);

	// 4) Remove "observation" prefixes that add no value ("Jeg kan se at ...").
	stripped = stripObservationPrefixes(stripped);

	// 5) Aggressively strip process/narration sentences from anywhere in the text.
	stripped = stripProcessSentences(stripped);

	// 6) Hard safety: remove write-SQL and "should I run it" prompts.
	const removed = {writeSql: false, runPrompt: false};
	stripped      = stripWriteSql(stripped, removed);
	stripped      = stripRunOrApplyPrompts(stripped, removed);

	// If stripping removed everything, keep the original (better to show something than nothing).
	if (!stripped) {
		return withoutThinking.trim();
	}

	// If stripping removed too much (e.g. >70% of content), keep the original.
	if (stripped.length < Math.floor(withoutThinking.length * 0.3)) {
		return withoutThinking.trim();
	}

	const finalText = stripped.trim();
	if (removed.writeSql || removed.runPrompt) {
		// Danish safety note (user-facing).
		const note = '\n\nBemærk: Jeg kan ikke foreslå eller køre write-SQL eller ændre kode. Jeg kan kun hjælpe med at finde årsagen og foreslå read-only verificeringer.';
		return (finalText + note).trim();
	}
	return finalText;
}

function stripWriteSql(text: string, removed: { writeSql: boolean; runPrompt: boolean }): string {
	const lines         = String(text || '').split(/\r?\n/);
	const out: string[] = [];
	let inFence         = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('```')) {
			inFence = !inFence;
			out.push(line);
			continue;
		}

		const sql         = trimmed.replace(/^\s*SQL\s*:\s*/i, '');
		const isWriteStmt = /^(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE|TRUNCATE|REPLACE)\b/i.test(sql);
		if (isWriteStmt) {
			removed.writeSql = true;
			// Drop the statement line entirely.
			continue;
		}

		// Also drop obvious multi-statement write blocks on one line.
		if (!inFence && /(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE|TRUNCATE|REPLACE)\b/i.test(sql) && sql.includes(';')) {
			removed.writeSql = true;
			continue;
		}

		out.push(line);
	}

	return out.join('\n').trim();
}

function stripRunOrApplyPrompts(text: string, removed: { writeSql: boolean; runPrompt: boolean }): string {
	// Remove user-facing "should I run/apply/execute this?" prompts.
	// Keep other clarifying questions intact.
	let out                  = String(text || '');
	const patterns: RegExp[] = [
		/\bskal\s+den\s+køres\??/gi,
		/\bskal\s+jeg\s+køre\s+det\??/gi,
		/\bskal\s+jeg\s+eksekvere\s+det\??/gi,
		/\bshould\s+i\s+run\s+this\??/gi,
		/\bshall\s+i\s+run\s+this\??/gi,
		/\bdo\s+you\s+want\s+me\s+to\s+run\s+this\??/gi,
		/\bdo\s+you\s+want\s+me\s+to\s+execute\s+this\??/gi,
		/\bskal\s+jeg\s+rette\s+det\??/gi,
		/\bdo\s+you\s+want\s+me\s+to\s+change\s+it\??/gi,
	];
	for (const re of patterns) {
		if (re.test(out)) {
			removed.runPrompt = true;
			out               = out.replace(re, '');
		}
	}
	return out.replace(/\n{3,}/g, '\n\n').trim();
}

function isNonAnswer(text: string): boolean {
	const t = String(text || '').trim();
	if (!t) {
		return true;
	}

	// Explicit "I cannot answer" patterns - these are ALWAYS non-answers
	const cannotAnswerPatterns = [
		/\bjeg\s+kan\s+ikke\s+give\s+dig\s+(?:et\s+)?(?:konkret|præcist|specifikt)?\s*svar\b/i,
		/\bjeg\s+kan\s+ikke\s+(?:svare|besvare)\s+(?:dette|dit|uden)\b/i,
		/\bfor\s+at\s+(?:hjælpe|besvare|svare)\s+dig\s+(?:skal|har)\s+jeg\s+brug\s+for\b/i,
		/\buden\s+at\s+undersøge\b/i,
		/\bi\s+cannot\s+(?:give|provide)\s+(?:you\s+)?(?:a\s+)?(?:concrete|specific|precise)?\s*answer\b/i,
		/\bi\s+need\s+(?:more\s+)?information\s+(?:to|before)\b/i,
	];
	for (const re of cannotAnswerPatterns) {
		if (re.test(t)) {
			return true;
		}
	}

	// Very short + process phrasing.
	if (t.length < 260 && /\b(jeg\s+undersøg\w*|jeg\s+skal\s+undersøg\w*|jeg\s+vil\s+undersøg\w*|lad\s+mig|i'?ll\s+search|i\s+will\s+search)\b/i.test(t)) {
		return true;
	}
	// If it contains no digits, no file paths, and no concrete nouns, it's likely non-responsive.
	const hasDigit    = /\d/.test(t);
	const hasPathLike = /[A-Za-z0-9_-]+\.(php|ts|tsx|js|jsx)\b/i.test(t) || /[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\b/.test(t);
	if (!hasDigit && !hasPathLike && t.length < 350) {
		return true;
	}
	return false;
}

function stripStandaloneProcessParagraphs(text: string): string {
	const paragraphs = String(text || '')
		.split(/\n{2,}/g)
		.map((p) => p.trim())
		.filter(Boolean);

	const processPara = [
		/^\s*lad\s+mig\b/i,
		/^\s*jeg\s+(?:vil\s+)?(?:først\s+)?(?:undersøg\w*|tjek\w*|kig\w*|find\w*|søge\w*)\b/i,
		/^\s*jeg\s+hjælper\b/i,
		/^\s*jeg\s+vil\s+hjælp\w*\b/i,
		/^\s*nu\s+kan\s+jeg\s+se\b/i,
		/^\s*vil\s+i\s+have\s+mig\b/i,
	];

	const kept: string[] = [];
	for (const p of paragraphs) {
		// If it's just a process paragraph (often ends with ":"), drop it.
		const isProcess            = processPara.some((re) => re.test(p));
		const looksLikeOnlyProcess = isProcess && (p.length < 220) && (p.endsWith(':') || !p.includes('\n'));
		if (looksLikeOnlyProcess) {
			continue;
		}
		kept.push(p);
	}

	return kept.join('\n\n').trim();
}

function stripObservationPrefixes(text: string): string {
	// This keeps the factual content but removes phrasing that feels like "thinking steps".
	// Only apply to sentence starts to avoid mangling content.
	let out = String(text || '');
	out     = out.replace(/(^|\n)(\s*)(jeg kan se at|nu kan jeg se at|jeg kan se)\s+/gmi, '$1$2');
	out     = out.replace(/(^|\n)(\s*)(lad mig)\s+/gmi, '$1$2');
	return out.trim();
}

/**
 * Aggressively strip process/narration sentences from the entire text.
 * These are sentences that describe what the AI is doing rather than providing answers.
 */
function stripProcessSentences(text: string): string {
	let out = String(text || '');
	if (!out.trim()) {
		return '';
	}

	// Patterns that match ENTIRE sentences to remove (process narration)
	const processPatterns: RegExp[] = [
		// "Jeg kan se problemet med X."
		/\bjeg\s+kan\s+se\s+(?:problemet|at|dette|det)\b[^.!?]*[.!?]\s*/gi,
		// "Nu har jeg fundet X." or "Nu har jeg fundet X:"
		/\bnu\s+har\s+jeg\s+fundet\b[^.!?:]*[.!?:]\s*/gi,
		// "Lad mig finde/se/tjekke/undersøge X:" or "Lad mig finde X."
		/\blad\s+mig\s+(?:finde|se|tjekke|undersøge|kigge|søge|først)\b[^.!?:]*[.!?:]\s*/gi,
		// "Perfekt! Nu kan jeg se at X."
		/\bperfekt[!.]*\s*(?:nu\s+)?(?:kan\s+jeg\s+se|jeg\s+kan\s+se)\b[^.!?]*[.!?]\s*/gi,
		// "Godt! Nu kan jeg se at X."
		/\bgodt[!.]*\s*(?:nu\s+)?(?:kan\s+jeg\s+se|jeg\s+kan\s+se)\b[^.!?]*[.!?]\s*/gi,
		// "Nu kan jeg se at X." / "Nu ser jeg at X."
		/\bnu\s+(?:kan\s+jeg\s+se|ser\s+jeg)\b[^.!?]*[.!?]\s*/gi,
		// "Nu skal jeg se/finde X."
		/\bnu\s+skal\s+jeg\s+(?:se|finde|tjekke|undersøge)\b[^.!?]*[.!?]\s*/gi,
		// "Jeg vil undersøge/tjekke/finde/hjælpe X."
		/\bjeg\s+vil\s+(?:undersøge|tjekke|finde|kigge|søge|hjælpe|først)\b[^.!?]*[.!?]\s*/gi,
		// "Jeg undersøger nu X." / "Jeg undersøger hvordan X."
		/\bjeg\s+undersøger\b[^.!?]*[.!?]\s*/gi,
		// "Jeg har fundet X."
		/\bjeg\s+har\s+fundet\b[^.!?]*[.!?]\s*/gi,
		// "Jeg leder efter X." / "Jeg søger efter X."
		/\bjeg\s+(?:leder|søger)\s+efter\b[^.!?]*[.!?]\s*/gi,
		// "Jeg checker/tjekker X."
		/\bjeg\s+(?:checker|tjekker|starter\s+med)\b[^.!?]*[.!?]\s*/gi,
	];

	for (const re of processPatterns) {
		out = out.replace(re, ' ');
	}

	// Clean up multiple spaces/newlines
	out = out.replace(/[ \t]+/g, ' ');
	out = out.replace(/\n{3,}/g, '\n\n');
	out = out.replace(/^\s+/gm, '');

	return out.trim();
}

function normalizeTitleCandidate(raw: string): string {
	const clean = (raw || '')
		// Remove common prefixes the model may include.
		.replace(/^\s*(titel|title)\s*:\s*/i, '')
		// Remove leading bullets/dashes.
		.replace(/^\s*[-–—]\s*/i, '')
		// Strip surrounding quotes/backticks.
		.replace(/^["'`]+|["'`]+$/g, '')
		// Normalize whitespace.
		.replace(/\s+/g, ' ')
		.trim();
	return sanitizeTitleText(clean);
}

function sanitizeTitleText(title: string): string {
	// Keep it readable and stable. Replace separators and remove trailing punctuation.
	return (title || '')
		.replace(/[|/\\]+/g, ' ')
		.replace(/\s*[-–—]\s*/g, ' – ')
		.replace(/\s+/g, ' ')
		.replace(/[.!,;:]+$/g, '')
		.trim();
}

function getTitleWordCount(title: string): number {
	const words = (title || '').match(/[A-Za-zÆØÅæøå0-9]+/g) || [];
	return words.length;
}

function isValidTitleCandidate(title: string): boolean {
	const trimmed = (title || '').trim();
	if (trimmed.length < 3) {
		return false;
	}

	const wordCount = getTitleWordCount(trimmed);
	if (wordCount < 3 || wordCount > 6) {
		return false;
	}

	// Reject "process" or assistant-style wording in titles.
	const forbidden = /\b(jeg|mig|min|hjælp\w*|kan|vil|skal|lad|find\w*|søge\w*|kig\w*|undersøg\w*|blev\w*|dannet)\b/i;
	if (forbidden.test(trimmed)) {
		return false;
	}

	// Reject titles that are mostly short filler tokens.
	const words      = (trimmed.match(/[A-Za-zÆØÅæøå0-9]+/g) || []).map((w) => w.toLowerCase());
	const shortWords = words.filter((w) => w.length <= 3).length;
	if (words.length >= 4 && shortWords >= Math.ceil(words.length * 0.6)) {
		return false;
	}

	return true;
}

function generateFallbackTitle(input: { userMessage: string; assistantAnswer: string; systemName: string }): string {
	const user   = input.userMessage || '';
	const answer = input.assistantAnswer || '';

	const returnNoMatch = user.match(/\b(?:return|retur|rma)\s*(?:no\.|nr\.|#)?\s*(\d{3,})\b/i);
	const orderMatch    = user.match(/\b(?:ordre|order)\s*(?:no\.|nr\.|#)?\s*(\d{3,})\b/i);
	const hasShopify    = /\bshopify\b/i.test(user) || /\bshopify\b/i.test(answer);
	const hasNemEdi     = /\bnemedi\b/i.test(user) || /\bnemedi\b/i.test(answer);

	if (hasNemEdi) {
		return 'NemEDI opsætning og fejlsøgning';
	}

	const parts: string[] = [];
	if (returnNoMatch?.[1]) {
		parts.push(`Return ${returnNoMatch[1]}`);
	} else if (orderMatch?.[1]) {
		parts.push(`Order ${orderMatch[1]}`);
	}

	if (hasShopify) {
		parts.push('Shopify webhook');
	}

	// If we have nothing concrete, fall back to a compact noun-phrase from the user message.
	if (parts.length === 0) {
		const tokens  = (user.match(/[A-Za-zÆØÅæøå0-9]+/g) || [])
			.filter((t) => t.length >= 4 || /^\d+$/.test(t));
		const top     = tokens.slice(0, 6).join(' ');
		const cleaned = sanitizeTitleText(top);
		return cleaned.length >= 3 ? cleaned.substring(0, 60).trim() : '';
	}

	let title = parts.join(' – ');
	title     = sanitizeTitleText(title);

	// Ensure word count fits 3-6 words; if not, trim conservatively.
	const words = (title.match(/[A-Za-zÆØÅæøå0-9]+/g) || []);
	if (words.length > 6) {
		title = words.slice(0, 6).join(' ');
	}
	return title.substring(0, 60).trim();
}

function estimateTokenCount(text: string): number {
	// NOTE: This is an approximation. Claude tokenization is not 1:1 with characters.
	// Empirically, ~4 chars per token is a decent rough estimate for mixed EN/DA prose.
	const normalized = String(text || '');
	if (!normalized) {
		return 0;
	}
	return Math.max(1, Math.ceil(normalized.length / 4));
}

function estimateTokenCountForMessages(messages: ChatMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		total += 4; // small overhead per message
		total += estimateTokenCount(extractTextFromClaudeContent(msg.content));
	}
	return total;
}

function extractTextFromClaudeContent(content: any): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		// Prefer the text blocks; ignore binary/image sources.
		return content
			.map((b) => {
				if (b && typeof b === 'object' && b.type === 'text' && typeof b.content === 'string') {
					return b.content;
				}
				return '';
			})
			.filter(Boolean)
			.join('\n');
	}
	if (content && typeof content === 'object') {
		// Best-effort.
		if (typeof (content as any).content === 'string') {
			return String((content as any).content);
		}
	}
	return '';
}

/**
 * Detect when a "continuation" response is actually a meta-comment saying
 * the answer was already complete, rather than genuine continuation content.
 */
function looksLikeNonContinuation(text: string): boolean {
	const t = String(text || '').trim().toLowerCase();
	if (!t) {
		return true;
	}

	// Exact "COMPLETE" sentinel we ask for in the continuation prompt
	if (t === 'complete') {
		return true;
	}

	// Common patterns where the model says the answer is already done
	const nonContinuationPatterns = [
		/\bthe answer is already complete\b/i,
		/\bno missing continuation\b/i,
		/\bno continuation (?:is )?needed\b/i,
		/\bnothing (?:more )?to (?:add|continue)\b/i,
		/\bthe (?:response|answer|sentence) (?:ends|is complete|is finished)\b/i,
		/\balready (?:complete|finished|ends)\b/i,
		/\bsvaret er (?:allerede )?(?:komplet|færdig|fuldendt)\b/i,
		/\bder er (?:ikke )?(?:mere|noget) at tilføje\b/i,
		/\bingen fortsættelse\b/i,
	];

	for (const re of nonContinuationPatterns) {
		if (re.test(t)) {
			return true;
		}
	}

	return false;
}

/**
 * Detect if the answer looks like it stopped mid-investigation:
 * Claude was still narrating its tool-use process and never reached a conclusion.
 */
function looksLikeMidInvestigation(text: string): boolean {
	const t = String(text || '').trim();
	if (!t || t.length < 100) {
		return false;
	}

	// Check if the answer ends with typical "process narration" patterns
	// (Claude describing what it's about to do next, or what it just found)
	const midInvestigationEndings = [
		/(?:nu\s+(?:skal|kan|vil|tjekker|checker|sammenligner|kigger)\s+jeg)\b/i,
		/(?:lad\s+mig\s+(?:prøve|tjekke|checke|undersøge|kigge|finde|query|hente|sammenligne))/i,
		/(?:nu\s+(?:checker|tjekker|henter|sammenligner|querier)\s+(?:jeg|vi))/i,
		/(?:jeg\s+(?:vil|skal|kan)\s+nu\s+(?:tjekke|checke|undersøge|sammenligne|query))/i,
		/(?:let\s+me\s+(?:check|try|query|look|search|compare|find|get))/i,
		/(?:now\s+(?:I\s+(?:can|will|need\s+to)|let's|checking|querying|comparing))/i,
		/(?:interessant!?\s)/i,
		/(?:nu\s+har\s+jeg\s+(?:alle?|de|det))/i,
	];

	// Check the last 300 chars for mid-investigation patterns
	const tail = t.slice(-300);
	for (const re of midInvestigationEndings) {
		if (re.test(tail)) {
			return true;
		}
	}

	// If there's no conclusion-like ending (answer, summary, result) and it's long,
	// it's likely an incomplete investigation.
	const hasConclusion = /sammenfattende|opsummering|konklusion|resultat(?:et)?|svaret?\s+er|total(?:t|en)?|i\s+alt|conclusion|summary|result|in\s+total|the\s+answer/i.test(tail);
	if (!hasConclusion && t.length > 1500 && looksTruncatedAnswer(t)) {
		return true;
	}

	return false;
}

function looksTruncatedAnswer(text: string): boolean {
	const t = String(text || '').trim();
	if (!t) {
		return false;
	}

	// Common truncation shapes: ends mid-word or with a dangling connector.
	const endsWithIncompleteWord = /[A-Za-zÆØÅæøå]\s*$/.test(t) && !/[.?!…]$/.test(t);
	const endsWithDangling       = /(,\s*[A-Za-zÆØÅæøå]{1,3}\s*)$/.test(t);
	const endsWithColon          = /:\s*$/.test(t);
	const endsWithOpenParen      = /\(\s*$/.test(t);
	if (endsWithDangling || endsWithColon || endsWithOpenParen) {
		return true;
	}

	// If it ends without punctuation and is reasonably long, consider it suspicious.
	if (!/[.?!…]$/.test(t) && t.length > 600) {
		return true;
	}

	return endsWithIncompleteWord;
}

async function runChatWithMaxTokensFallback(
	chatFn: (options: any) => Promise<unknown>,
	options: any,
	context: {
		onDebugLog?: (type: 'query' | 'tool' | 'api' | 'error' | 'info', category: string, message: string, details?: string) => void;
		label: string;
	},
): Promise<unknown> {
	try {
		return await chatFn(options);
	} catch (error) {
		const message           = error instanceof Error ? error.message : String(error);
		// If the model rejects the requested maxTokens, retry with a safer cap.
		const mightBeTokenLimit = /max[\s_-]?tokens|max[\s_-]?_tokens|too many tokens|must be <=|maximum/i.test(message);
		if (!mightBeTokenLimit) {
			throw error;
		}
		const fallbackMaxTokens = 6000;
		context.onDebugLog?.(
			'info',
			'Claude API',
			`${context.label}: maxTokens rejected; retrying with ${fallbackMaxTokens}`,
			message,
		);
		return await chatFn({...options, maxTokens: fallbackMaxTokens});
	}
}

type DebugLogFn = (type: 'query' | 'tool' | 'api' | 'error' | 'info', category: string, message: string, details?: string) => void;

/**
 * Extract text content from a TanStack AI chat response.
 * When stream: false, the response is an async iterable of events.
 * We need to iterate and collect TEXT_MESSAGE_CONTENT deltas.
 */
async function extractTextFromChatResponse(response: unknown, onDebugLog?: DebugLogFn, label?: string): Promise<string> {
	const logLabel = label || 'extractText';

	// If it's already a string, return it
	if (typeof response === 'string') {
		if (response.length === 0) {
			onDebugLog?.('info', logLabel, 'Response is empty string - this might indicate an API issue');
		} else {
			onDebugLog?.('info', logLabel, `Response is string, length: ${response.length}`);
		}
		return response;
	}

	// If it's null/undefined, return empty
	if (!response) {
		onDebugLog?.('info', logLabel, 'Response is null/undefined');
		return '';
	}

	// If it's an async iterable (stream), iterate and collect text
	if (typeof (response as any)[Symbol.asyncIterator] === 'function') {
		onDebugLog?.('info', logLabel, 'Response is async iterable, iterating...');
		let text                   = '';
		let eventCount             = 0;
		const eventTypes: string[] = [];
		for await (const event of response as AsyncIterable<any>) {
			eventCount++;
			const eventType = event?.type || 'unknown';
			if (!eventTypes.includes(eventType)) {
				eventTypes.push(eventType);
			}

			// Capture RUN_ERROR details
			if (event?.type === 'RUN_ERROR') {
				const errorMsg = event?.error?.message || event?.message || JSON.stringify(event).slice(0, 500);
				onDebugLog?.('error', logLabel, `RUN_ERROR encountered: ${errorMsg}`);
			}

			if (event?.type === 'TEXT_MESSAGE_CONTENT' && typeof event.delta === 'string') {
				text += event.delta;
			}
			// Also check for other common text event types
			if (event?.type === 'text' && typeof event.content === 'string') {
				text += event.content;
			}
			if (event?.type === 'content_block_delta' && event?.delta?.text) {
				text += event.delta.text;
			}
		}
		onDebugLog?.('info', logLabel, `Iterated ${eventCount} events, types: ${eventTypes.join(', ')}, text length: ${text.length}`);
		return text.trim();
	}

	// Check if it's an object with a text property
	if (typeof response === 'object' && response !== null) {
		const obj = response as Record<string, any>;

		// Log detailed object info for debugging
		const constructorName = obj.constructor?.name || 'unknown';
		const keys            = Object.keys(obj).slice(0, 15);
		onDebugLog?.('info', logLabel, `Response is object: ${constructorName}, keys: ${keys.join(', ')}`);

		// Check for messages array (TanStack AI chat response format)
		if (Array.isArray(obj.messages)) {
			const lastMessage = obj.messages[obj.messages.length - 1];
			if (lastMessage?.role === 'assistant') {
				if (typeof lastMessage.content === 'string') {
					onDebugLog?.('info', logLabel, `Found .messages[] -> assistant.content string, length: ${lastMessage.content.length}`);
					return lastMessage.content;
				}
				if (Array.isArray(lastMessage.content)) {
					const textContent = lastMessage.content
						.filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
						.map((c: any) => c.text)
						.join('');
					if (textContent) {
						onDebugLog?.('info', logLabel, `Found .messages[] -> assistant.content array, length: ${textContent.length}`);
						return textContent;
					}
				}
			}
		}

		if (typeof obj.text === 'string') {
			onDebugLog?.('info', logLabel, `Response has .text property, length: ${obj.text.length}`);
			return obj.text;
		}
		if (typeof obj.content === 'string') {
			onDebugLog?.('info', logLabel, `Response has .content property, length: ${obj.content.length}`);
			return obj.content;
		}
		if (Array.isArray(obj.content)) {
			const textContent = obj.content
				.filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
				.map((c: any) => c.text)
				.join('');
			if (textContent) {
				onDebugLog?.('info', logLabel, `Response has .content array, extracted text length: ${textContent.length}`);
				return textContent;
			}
		}

		// Check for result property (some API wrappers use this)
		if (typeof obj.result === 'string') {
			onDebugLog?.('info', logLabel, `Response has .result property, length: ${obj.result.length}`);
			return obj.result;
		}

		// Check for response property (nested response)
		if (obj.response && typeof obj.response === 'object') {
			onDebugLog?.('info', logLabel, 'Response has nested .response, recursing...');
			return extractTextFromChatResponse(obj.response, onDebugLog, logLabel + ' (nested)');
		}
	}

	// Fallback: try to stringify
	const str = String(response);
	if (str === '[object Object]' || str === '[object AsyncGenerator]') {
		onDebugLog?.('info', logLabel, 'Fallback stringify returned useless string');
		return '';
	}
	onDebugLog?.('info', logLabel, `Fallback stringify, length: ${str.length}`);
	return str.trim();
}
