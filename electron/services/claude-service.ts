import Anthropic from '@anthropic-ai/sdk';
import {app} from 'electron';
import * as fs from 'fs/promises';
import path from 'path';
import type {DatabaseService} from './database-service';
import type {GitHubService} from './github-service';
import {SecureStorageService} from './secure-storage-service';
import type {SchemaIndexService} from './schema-index-service';
import type {ChatService} from './chat-service';
import type {AttachmentMeta, AttachmentService} from './attachment-service';
import {VectorStoreService} from './vector-store-service';

export class ClaudeService {
	private readonly secureStorage: SecureStorageService;
	private client: Anthropic | null               = null;
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
		this.client = new Anthropic({apiKey: trimmedKey});
	}

	private async ensureClient(): Promise<Anthropic> {
		if (this.client) {
			return this.client;
		}

		const apiKey = await this.getApiKey();
		if (!apiKey) {
			throw new Error('Claude API key not configured');
		}

		this.client = new Anthropic({apiKey});
		return this.client;
	}

	private escapeCsvValue(value: string): string {
		// Escape CSV values: wrap in quotes if contains comma, quote, or newline
		if (value.includes(',') || value.includes('"') || value.includes('\n')) {
			return `"${value.replace(/"/g, '""')}"`;
		}
		return value;
	}

	private truncateLargeToolResult(result: unknown, maxRows: number = 100, maxLines: number = 500): { truncated: boolean; data: unknown } {
		// Check if result is a database query result with rows
		const queryResult = result as { rows?: any[]; rowCount?: number; [key: string]: any };

		if (queryResult.rows && Array.isArray(queryResult.rows)) {
			const totalRows = queryResult.rows.length;

			if (totalRows > maxRows) {
				// Truncate to maxRows and add metadata
				return {
					truncated: true,
					data     : {
						...queryResult,
						rows             : queryResult.rows.slice(0, maxRows),
						originalRowCount : totalRows,
						truncatedRowCount: maxRows,
						truncationNote   : `Result truncated: showing first ${maxRows} of ${totalRows} rows. Use LIMIT in your query to control output size.`,
					},
				};
			}
		}

		// Check if result is a GitHub file content (string with many lines)
		if (typeof result === 'string' && result.includes('\n')) {
			const lines = result.split('\n');

			if (lines.length > maxLines) {
				const truncatedContent = lines.slice(0, maxLines).join('\n');
				const remainingLines   = lines.length - maxLines;

				const guidanceMessage = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FILE TRUNCATED - ${remainingLines} MORE LINES NOT SHOWN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Total lines in file: ${lines.length}
Lines shown: ${maxLines}
Lines omitted: ${remainingLines}

TO ACCESS THE REST OF THE FILE:

1. Use the 'search_code' tool to find specific functions, classes, or methods you need.
   Example: search_code("function generateEanExcel")
   Example: search_code("class POrder")

2. Search for specific keywords or patterns that appear in the code you're looking for.
   Example: search_code("Size column Excel")

3. If you need a specific section, ask the user to search for it in their local codebase
   and paste the relevant code snippet.

This truncation prevents token limit errors. Use targeted searches instead of reading entire large files.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

				return {
					truncated: true,
					data     : truncatedContent + guidanceMessage,
				};
			}
		}

		// Check if result is a GitHub search result array
		if (Array.isArray(result)) {
			const maxResults = 10; // Limit search results to first 10

			if (result.length > maxResults) {
				return {
					truncated: true,
					data     : [
						...result.slice(0, maxResults),
						{
							truncationNote: `Search results truncated: showing first ${maxResults} of ${result.length} results. Refine your search query for more specific results.`,
						},
					],
				};
			}
		}

		return {truncated: false, data: result};
	}

	private async exportToCsv(filename: string, data: Array<Record<string, unknown>>): Promise<Record<string, unknown>> {
		if (data.length === 0) {
			return {error: 'No data to export'};
		}

		// Get column headers from first row
		const headers           = Object.keys(data[0]);
		const csvRows: string[] = [];

		// Add header row
		csvRows.push(headers.map((h) => this.escapeCsvValue(h)).join(','));

		// Add data rows
		for (const row of data) {
			const values = headers.map((h) => this.escapeCsvValue(String(row[h] ?? '')));
			csvRows.push(values.join(','));
		}

		const csvContent = csvRows.join('\n');

		// Save to downloads folder
		const downloadsPath = app.getPath('downloads');
		const filePath      = path.join(downloadsPath, filename);
		await fs.writeFile(filePath, csvContent, 'utf-8');

		return {
			success : true,
			filePath,
			rowCount: data.length,
			message : `CSV file saved to Downloads folder: ${filename}`,
		};
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
		attachments?: AttachmentMeta[],
		onDebugLog?: (type: 'query' | 'tool' | 'api' | 'error' | 'info', category: string, message: string, details?: string) => void,
	): Promise<{ shortAnswer: string; detailedAnswer: string }> {
		const looksLikeUiQuestion = (text: string): boolean => {
			const t = text.toLowerCase();
			// Danish + English UI intent keywords
			return /(\bhvordan\b|\bhvor\b|\bklik\b|\bknap\b|\bmenu\b|\bfane\b|\bfelt\b|\bside\b|\bskærm\b|\bui\b|\binterface\b|\bfind\b|\bopret\b|\bredig(é|e)r\b|\bslet\b|\bfilter\b|\bsøg\b|\bexport\b|\budtræk\b|\boversigt\b|\bwhy\b|\bwhere\b|\bbutton\b|\bmenu\b|\bpage\b|\bfield\b)/i
				.test(t);
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
				const frag = (r.matches && r.matches.length > 0) ? r.matches[0].replace(/\s+/g, ' ').trim() : '';
				lines.push(`- ${r.path}${frag ? `: ${frag}` : ''}`);
			}
			return lines.join('\n');
		};

		const sqlKeywordSet = new Set([
			'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON',
			'GROUP', 'BY', 'ORDER', 'LIMIT', 'HAVING', 'AS', 'DISTINCT',
			'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
			'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
			'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS',
			'UNION', 'ALL',
			'DESC', 'ASC',
			'TRUE', 'FALSE',
		]);

		const extractTableNames = (sql: string): string[] => {
			const names: string[] = [];
			const re              = /\b(?:FROM|JOIN)\s+`?([a-zA-Z0-9_]+)`?/gi;
			let m: RegExpExecArray | null;
			while ((m = re.exec(sql)) !== null) {
				if (m[1]) {
					names.push(m[1]);
				}
			}
			return Array.from(new Set(names));
		};

		const extractPossibleColumnNamesSingleTable = (sql: string): string[] => {
			// Conservative heuristic: only validate identifiers used in WHERE for single-table queries.
			// This avoids false positives for SELECT aliases like "COUNT(*) AS total".
			const whereMatch = sql.match(/\bWHERE\b([\s\S]*?)(\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b|$)/i);
			if (!whereMatch) {
				return [];
			}
			const whereSql = whereMatch[1] ?? '';

			const tokens = whereSql
				.replace(/'[^']*'/g, ' ') // remove single-quoted strings
				.replace(/"[^"]*"/g, ' ') // remove double-quoted strings
				.match(/[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?|`[a-zA-Z0-9_]+`(?:\.`[a-zA-Z0-9_]+`)?/g) || [];

			const out: string[] = [];
			for (const raw of tokens) {
				// Support qualified identifiers like customers.type
				const cleanedRaw = raw.replace(/`/g, '');
				const parts      = cleanedRaw.split('.');
				const ident      = parts.length === 2 ? parts[1] : parts[0];
				if (!ident) {
					continue;
				}
				const upper = ident.toUpperCase();
				if (sqlKeywordSet.has(upper)) {
					continue;
				}
				if (ident.length <= 1) {
					continue;
				}
				out.push(ident);
			}
			return Array.from(new Set(out));
		};

		const suggestColumnsFromTable = (
			table: { tableName: string; columns: Array<{ columnName: string }> },
			needle: string,
			limit: number = 10,
		): Array<{ tableName: string; columnName: string }> => {
			const needleLower                                                   = needle.toLowerCase();
			const suggestions: Array<{ tableName: string; columnName: string }> = [];
			const tryNeedles                                                    = Array.from(new Set([
				needleLower,
				...needleLower.split('_').filter((p) => p.length >= 3),
			]));

			for (const n of tryNeedles) {
				for (const c of table.columns) {
					if (c.columnName.toLowerCase().includes(n)) {
						suggestions.push({tableName: table.tableName, columnName: c.columnName});
						if (suggestions.length >= limit) {
							return suggestions;
						}
					}
				}
			}
			return suggestions;
		};

		const preflightQueryAgainstSchemaIndex = async (configId: string, sql: string): Promise<{
			ok: boolean;
			error?: string;
			hints?: any;
		}> => {
			const index = await schemaIndexService.loadIndex(configId);
			if (!index) {
				return {ok: true};
			}

			const tables = extractTableNames(sql);
			if (tables.length === 0) {
				return {ok: true};
			}

			const missingTables = tables.filter((t) => !schemaIndexService.getTable(index, t));
			if (missingTables.length > 0) {
				return {
					ok   : false,
					error: `Schema index: table(s) not found: ${missingTables.join(', ')}`,
					hints: {
						unknownTable: missingTables.map((t) => ({
							requested  : t,
							suggestions: schemaIndexService.searchSchema(index, t, 10),
						})),
					},
				};
			}

			// Only attempt column validation for simple single-table queries (no JOINs).
			const hasJoin = /\bJOIN\b/i.test(sql);
			if (tables.length === 1 && !hasJoin) {
				const table = schemaIndexService.getTable(index, tables[0]);
				if (table) {
					const columnSet  = new Set(table.columns.map((c) => c.columnName.toLowerCase()));
					const candidates = extractPossibleColumnNamesSingleTable(sql)
						.filter((c) => c.toLowerCase() !== table.tableName.toLowerCase());

					const missingCols = candidates.filter((c) => !columnSet.has(c.toLowerCase()));
					// Only block if it looks like a clear mismatch (avoid over-blocking on aliases).
					if (missingCols.length > 0) {
						const suggestions: Array<{ requested: string; suggestions: Array<{ tableName: string; columnName: string }> }> = [];
						for (const col of missingCols.slice(0, 5)) {
							const s = suggestColumnsFromTable(table, col, 10);
							suggestions.push({requested: col, suggestions: s});
						}

						return {
							ok   : false,
							error: `Schema index: potential unknown column(s) in ${table.tableName}`,
							hints: {
								table         : table.tableName,
								missingColumns: missingCols.slice(0, 10),
								suggestions,
								note          : 'If these are aliases (AS ...), qualify columns or rename aliases. Otherwise, use get_table_schema_cached to verify exact column names.',
							},
						};
					}
				}
			}

			return {ok: true};
		};

		// Get database connection info for context
		let dbServerHost = '';
		if (databaseIds.length > 0) {
			const configs = await databaseService.getConfigs();
			const config  = configs.find((c) => c.id === databaseIds[0]);
			if (config) {
				dbServerHost = config.host;
			}
		}
		const client = await this.ensureClient();

		onProgress?.('Preparing tools...');

		// Build tools for database access
		const tools: Anthropic.Tool[] = [];

		// Check if GitHub is configured
		const githubConfig = await githubService.getConfig();
		const hasGitHub    = !!githubConfig;

		if (githubConfig) {
			console.log('[ClaudeService] GitHub repo:', `${githubConfig.owner}/${githubConfig.repo}@${githubConfig.branch}`);
		}

		// Add database query tools only if database is specified
		if (databaseName && databaseIds.length > 0) {
			for (const dbId of databaseIds) {
				const configs = await databaseService.getConfigs();
				const config  = configs.find((c) => c.id === dbId);

				if (config) {
					const dbDisplayName = databaseName || config.database || config.name;
					const toolSuffix    = config.name.toLowerCase().replace(/\s+/g, '_');

					tools.push({
						name        : `query_${toolSuffix}`,
						description : `Execute a READ-ONLY SQL query on database: ${dbDisplayName}. BEFORE running complex queries, verify table/column names using the LOCAL schema index tools (search_schema / get_table_schema_cached) when available. ONLY SELECT, SHOW, DESCRIBE, and EXPLAIN queries are allowed. Write operations (INSERT, UPDATE, DELETE, etc.) are NEVER permitted.`,
						input_schema: {
							type      : 'object',
							properties: {
								query: {
									type       : 'string',
									description: 'The SQL SELECT query to execute (read-only)',
								},
							},
							required  : ['query'],
						},
					});

					tools.push({
						name        : `list_tables_${toolSuffix}`,
						description : `List all tables in database: ${dbDisplayName}`,
						input_schema: {
							type      : 'object',
							properties: {},
						},
					});

					tools.push({
						name        : `describe_table_${toolSuffix}`,
						description : `Get schema information for a table in database: ${dbDisplayName}`,
						input_schema: {
							type      : 'object',
							properties: {
								table_name: {
									type       : 'string',
									description: 'Name of the table to describe',
								},
							},
							required  : ['table_name'],
						},
					});

					tools.push({
						name        : `search_schema_${toolSuffix}`,
						description : `Search the LOCAL schema index (tables, columns, keys) for database: ${dbDisplayName}. Prefer this over DESCRIBE when the schema index has been generated in Settings.`,
						input_schema: {
							type      : 'object',
							properties: {
								query: {
									type       : 'string',
									description: 'Search query for tables/columns (case-insensitive substring match)',
								},
								limit: {
									type       : 'number',
									description: 'Maximum number of table matches to return (default 10)',
								},
							},
							required  : ['query'],
						},
					});

					tools.push({
						name        : `get_table_schema_cached_${toolSuffix}`,
						description : `Get table schema from the LOCAL schema index for database: ${dbDisplayName}. Prefer this over DESCRIBE when the schema index has been generated in Settings.`,
						input_schema: {
							type      : 'object',
							properties: {
								table_name: {
									type       : 'string',
									description: 'Name of the table to look up in the local schema index',
								},
							},
							required  : ['table_name'],
						},
					});
				}
			}

			// Add CSV export tool if database is connected
			tools.push({
				name        : 'export_to_csv',
				description : 'Export query results to a CSV file in the Downloads folder. ALWAYS use this tool when user asks for: "list", "liste", "export", "eksporter", "udtræk", "oversigt", "extract", "overview" or similar data extraction requests. The file will be automatically saved with a timestamp.',
				input_schema: {
					type      : 'object',
					properties: {
						query   : {
							type       : 'string',
							description: 'The SQL SELECT query to execute and export',
						},
						filename: {
							type       : 'string',
							description: 'Name for the CSV file (without extension)',
						},
					},
					required  : ['query', 'filename'],
				},
			});
		}

		// Add GitHub tools if configured
		if (hasGitHub && githubConfig) {
			tools.push({
				name        : 'search_code',
				description : `Search for code in the ${githubConfig.owner}/${githubConfig.repo} repository. WARNING: Results are limited to first 10 matches to prevent token overflow. Use specific queries to find the most relevant files.`,
				input_schema: {
					type      : 'object',
					properties: {
						query: {
							type       : 'string',
							description: 'Specific search query (e.g., "function calculatePrice", "class Customer"). Make it precise to get the most relevant results.',
						},
					},
					required  : ['query'],
				},
			});

			tools.push({
				name        : 'read_file',
				description : `Read the contents of a file from the ${githubConfig.owner}/${githubConfig.repo} repository. WARNING: Files over 500 lines are automatically truncated to prevent token limit errors. Read only essential files and avoid reading many large files in one request.`,
				input_schema: {
					type      : 'object',
					properties: {
						file_path: {
							type       : 'string',
							description: 'Path to the file (e.g., "src/components/ChatView.tsx")',
						},
					},
					required  : ['file_path'],
				},
			});

			tools.push({
				name        : 'list_files',
				description : `List files in a directory from the ${githubConfig.owner}/${githubConfig.repo} repository`,
				input_schema: {
					type      : 'object',
					properties: {
						directory_path: {
							type       : 'string',
							description: 'Path to the directory (empty string for root)',
						},
					},
					required  : ['directory_path'],
				},
			});

			tools.push({
				name        : 'get_repository_structure',
				description : `Get the complete file tree structure of the ${githubConfig.owner}/${githubConfig.repo} repository`,
				input_schema: {
					type      : 'object',
					properties: {},
				},
			});
		}


		// Start conversation with history if provided
		const messages: Anthropic.MessageParam[] = [];

		if (conversationHistory && conversationHistory.length > 0) {
			// Add all previous messages
			for (const msg of conversationHistory) {
				messages.push({
					role   : msg.role as 'user' | 'assistant',
					content: msg.content,
				});
			}
		}

		// Add the new user message (with optional attachments)
		let userText               = userMessage;
		const contentBlocks: any[] = [];
		try {
			if (attachments && attachments.length > 0) {
				onProgress?.(`Processing ${attachments.length} attachment(s)...`);
				for (const att of attachments) {
					if (att.mimeType && att.mimeType.startsWith('image/')) {
						const buf = await attachmentService.readAttachmentBuffer(att.storedPath);
						contentBlocks.push({
							type  : 'image',
							source: {
								type      : 'base64',
								media_type: att.mimeType,
								data      : buf.toString('base64'),
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
			contentBlocks.unshift({type: 'text', text: userText});
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
				const githubConfigForUi = await githubService.getConfig();
				if (githubConfigForUi) {
					onProgress?.('Searching UI codebase...');
					const keywords      = extractSearchKeywords(userMessage, 4);
					// Prefer user text; fallback to keyword query if needed.
					const query         = keywords.length > 0 ? keywords.join(' ') : userMessage;
					const uiResults     = await githubService.searchCode(query);
					uiCodeSearchSection = formatUiCodeSearchResults(uiResults);
					if (uiCodeSearchSection) {
						onDebugLog?.('info', 'UI Grounding', `Found ${uiResults.length} code search results for: ${query}`);
					} else {
						onDebugLog?.('info', 'UI Grounding', `No code search results for: ${query}`);
					}
				}
			}
		} catch (error) {
			onDebugLog?.('error', 'UI Grounding', 'UI code search failed', String(error));
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

		// Build system prompt
		let systemPrompt = `You are a helpful assistant that answers questions accurately and clearly. ALWAYS respond in the same language as the user's question.

THINKING PROCESS:
Before using any tools, use <thinking> tags to plan your approach:
- What information do I need to answer this question?
- Do I need to query the database, or can I answer from existing knowledge?
- Do I need to look at code files, or is this a data question?
- What's the most efficient way to get the answer?

Use your thinking to avoid unnecessary work - don't query the database if you can answer from context, and don't search code if you just need data.

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
			const chat = await chatService.getChat(chatId);
			const ws   = (chat as any)?.workingSummary?.text ? String((chat as any).workingSummary.text) : '';
			if (ws.trim() !== '') {
				workingSummaryText = ws.trim();
			}
		} catch (error) {
			onDebugLog?.('error', 'Working Summary', 'Failed to load working summary', String(error));
		}

		if (workingSummaryText) {
			systemPrompt += `\n\nWORKING SUMMARY (CHAT MEMORY):\n${workingSummaryText}\n\nUse this as current chat context. If you discover a contradiction, prioritize tool output and update your internal understanding.`;
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

		if (databaseName && databaseIds.length > 0) {
			const serverDisplayName = dbServerHost.replace('.spysystem.dk', '');
			systemPrompt += `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SYSTEM CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are connected to the SPY System - a comprehensive warehouse management and e-commerce platform built with PHP 8.1 backend and React 19 frontend.

CURRENT CONNECTION:
- Database: ${databaseName}
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

LOCAL SCHEMA INDEX:
${schemaIndexInfo?.exists
				? `- Status: AVAILABLE\n- Generated: ${schemaIndexInfo.generatedAtIso}\n- Tables: ${schemaIndexInfo.tableCount}\n- Source: ${schemaIndexInfo.source}\n- IMPORTANT: Prefer schema-index tools (search_schema / get_table_schema_cached) for table/column discovery.`
				: `- Status: NOT AVAILABLE\n- Recommendation: Ask the user to generate it in Settings → Database Connection → Database Schema Index.\n- Until then, use describe_table when you must verify columns.`}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATABASE SECURITY & QUERY RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL SECURITY REQUIREMENT:
All database operations are READ-ONLY. You can ONLY execute SELECT, SHOW, DESCRIBE, and EXPLAIN queries.
NEVER attempt INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, or any other write operations.
Any attempt to write to the database will be blocked and result in an error.
Write operations are NEVER permitted under any circumstances.

IMPORTANT QUERY RULES:
1. NEVER query from views that start with "bi_" (e.g., bi_orders, bi_customers, bi_sales)
   - These are BI/analytics views and should be avoided
   - Always use the actual database tables directly instead of BI views
   - If you see a table name starting with "bi_", ignore it and find the equivalent regular table

2. Common table patterns in SPY system:
   - customer: Customer data
   - orders: Order headers
   - orders_lines: Order line items
   - style: Product styles/SKUs
   - assortment: Product assortments/collections
   - packing: Warehouse packing operations
   - shipping: Shipping/delivery information
   - brand: Brand information
   - season: Season definitions

3. Prefer the LOCAL schema index tools first:
   - Use search_schema to discover the correct table/column names
   - Use get_table_schema_cached to verify columns and keys
   - If the index is missing, ask the user to generate it in Settings → Database Connection → Database Schema Index
   - Only use describe_table when the local index is missing or looks outdated

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

1. Use the export_to_csv tool to automatically create a CSV file in the Downloads folder
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
- If an image/screenshot is provided, quote the exact labels you can see.
- If no screenshot is provided, use code search results (if present) to ground exact labels.
- If you still cannot ground the UI labels, ask ONE clarifying question (e.g. \"Which page are you on?\" or \"Please paste a screenshot\").

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

		// Use prompt caching to reduce token usage and avoid token limit errors
		// Cache the system prompt since it's large and relatively stable
		let response = await client.messages.create({
			model     : 'claude-sonnet-4-5-20250929',
			max_tokens: 4096,
			system    : [
				{
					type         : 'text',
					text         : systemPrompt,
					cache_control: {type: 'ephemeral'},
				},
			],
			tools,
			messages,
			thinking  : {
				type         : 'enabled',
				budget_tokens: 2000,
			},
		});

		onDebugLog?.('api', 'Claude API', `Response received - stop_reason: ${response.stop_reason}`);

		// Log thinking blocks if present
		const thinkingBlocks = response.content.filter((c: any) => c.type === 'thinking');
		if (thinkingBlocks.length > 0) {
			thinkingBlocks.forEach((thinking: any, index: number) => {
				onDebugLog?.('info', 'Claude Thinking', `Thought process ${index + 1}:`, thinking.thinking);
			});
		}

		onProgress?.('Processing response...');

		// Handle tool use loop
		let iterations      = 0;
		const maxIterations = 10;

		// Track query results for auto CSV export
		const queryResults: Array<{ query: string; data: any[] }> = [];

		while (response.stop_reason === 'tool_use' && iterations < maxIterations) {
			iterations++;

			const toolResults: Anthropic.ToolResultBlockParam[] = [];
			const toolCount                                     = response.content.filter((c) => c.type === 'tool_use').length;
			let currentTool                                     = 0;

			for (const content of response.content) {
				if (content.type === 'tool_use') {
					currentTool++;
					const toolName  = content.name;
					const toolInput = content.input as Record<string, unknown>;

					try {
						let result: unknown;

						// Handle GitHub tools
						if (toolName === 'search_code') {
							const query = toolInput.query as string;
							onProgress?.(`Searching code: ${query.substring(0, 40)}... (${currentTool}/${toolCount})`);
							onDebugLog?.('tool', 'GitHub', `Searching code: ${query}`, `Tool: ${toolName}\nQuery: ${query}`);
							result = await githubService.searchCode(query);
							onDebugLog?.('tool', 'GitHub', `Search completed - found ${(result as any).length || 0} results`);
						} else if (toolName === 'read_file') {
							const filePath = toolInput.file_path as string;
							onProgress?.(`Reading file: ${filePath} (${currentTool}/${toolCount})`);
							onDebugLog?.('tool', 'GitHub', `Reading file: ${filePath}`, `Tool: ${toolName}\nFile: ${filePath}`);
							result = await githubService.getFileContent(filePath);
							onDebugLog?.('tool', 'GitHub', `File read successfully: ${filePath}`);
						} else if (toolName === 'list_files') {
							const dirPath = toolInput.directory_path as string;
							onProgress?.(`Listing files in: ${dirPath || '/'} (${currentTool}/${toolCount})`);
							onDebugLog?.('tool', 'GitHub', `Listing files in: ${dirPath || '/'}`, `Tool: ${toolName}\nDirectory: ${dirPath}`);
							result = await githubService.listFiles(dirPath);
							onDebugLog?.('tool', 'GitHub', `Listed ${(result as any).length || 0} files`);
						} else if (toolName === 'get_repository_structure') {
							onProgress?.(`Getting repository structure (${currentTool}/${toolCount})`);
							onDebugLog?.('tool', 'GitHub', `Getting repository structure`, `Tool: ${toolName}`);
							result = await githubService.getTree(true);
							onDebugLog?.('tool', 'GitHub', `Repository structure retrieved`);
						}
						// Handle CSV export tool
						else if (toolName === 'export_to_csv') {
							const query    = toolInput.query as string;
							const filename = toolInput.filename as string;

							// Find database config
							const configs = await databaseService.getConfigs();
							const config  = configs.find((c) => c.id === databaseIds[0]);

							if (!config) {
								throw new Error('Database config not found for CSV export');
							}

							onProgress?.(`Exporting to CSV: ${filename}.csv (${currentTool}/${toolCount})`);
							onDebugLog?.('tool', 'CSV Export', `Exporting query results to ${filename}.csv`, query);

							// Execute query
							const queryResult = await databaseService.executeQuery(
								config.id,
								query,
								databaseName,
							);

							const queryResultObj = queryResult as { rows?: any[]; rowCount?: number };
							if (!queryResultObj.rows || queryResultObj.rows.length === 0) {
								throw new Error('Query returned no data to export');
							}

							// Generate unique filename with timestamp
							const now          = new Date();
							const dateStr      = now.toISOString().split('T')[0];
							const timeStr      = now.toTimeString().split(' ')[0].replace(/:/g, '-');
							const fullFilename = `${filename}_${dateStr}_${timeStr}.csv`;

							// Export to CSV
							result = await this.exportToCsv(fullFilename, queryResultObj.rows);
							onDebugLog?.('tool', 'CSV Export', `Successfully exported ${queryResultObj.rows.length} rows to ${fullFilename}`);
						}
						// Handle database tools
						else if (toolName.startsWith('query_')) {
							// Find which database this tool belongs to
							const configs = await databaseService.getConfigs();
							const config  = configs.find((c) => {
								const dbName = c.name.toLowerCase().replace(/\s+/g, '_');
								return toolName.includes(dbName);
							});

							if (!config) {
								throw new Error(`Database config not found for tool: ${toolName}`);
							}

							const query      = toolInput.query as string;
							const shortQuery = query.length > 60
								? query.substring(0, 60) + '...'
								: query;
							onProgress?.(`Running query (${currentTool}/${toolCount}): ${shortQuery}`);
							onDebugLog?.('query', 'Database Query', `Executing query on ${databaseName}`, query);

							// Preflight against local schema index to prevent avoidable DB errors.
							if (databaseName) {
								const preflight = await preflightQueryAgainstSchemaIndex(config.id, query);
								if (!preflight.ok) {
									result = {
										error         : preflight.error,
										hints         : preflight.hints,
										recommendation: 'Use search_schema and/or get_table_schema_cached to verify table/column names before running the query.',
									};
									onDebugLog?.('tool', 'Schema Index', 'Preflight blocked a likely-invalid query', JSON.stringify(result, null, 2));
									toolResults.push({
										type       : 'tool_result',
										tool_use_id: content.id,
										content    : JSON.stringify(result, null, 2),
										is_error   : true,
									});
									continue;
								}
							}

							result = await databaseService.executeQuery(
								config.id,
								query,
								databaseName,
							);

							// Track query results for potential CSV export
							const queryResultObj = result as { rows?: any[]; rowCount?: number };
							if (queryResultObj.rows && queryResultObj.rows.length > 0) {
								queryResults.push({query, data: queryResultObj.rows});
							}

							onDebugLog?.('query', 'Database Query', `Query completed - ${queryResultObj.rowCount || 0} rows returned`);
						} else if (toolName.startsWith('list_tables_')) {
							// Find which database this tool belongs to
							const configs = await databaseService.getConfigs();
							const config  = configs.find((c) => {
								const dbName = c.name.toLowerCase().replace(/\s+/g, '_');
								return toolName.includes(dbName);
							});

							if (!config) {
								throw new Error(`Database config not found for tool: ${toolName}`);
							}

							onProgress?.(`Listing tables in ${config.name} (${currentTool}/${toolCount})`);
							onDebugLog?.('query', 'Database Schema', `Listing tables in ${databaseName}`, `SHOW TABLES`);
							result = await databaseService.listTables(config.id, databaseName);
							onDebugLog?.('query', 'Database Schema', `Found ${(result as string[]).length} tables`);
						} else if (toolName.startsWith('search_schema_')) {
							// Find which database this tool belongs to
							const configs = await databaseService.getConfigs();
							const config  = configs.find((c) => {
								const dbName = c.name.toLowerCase().replace(/\s+/g, '_');
								return toolName.includes(dbName);
							});

							if (!config) {
								throw new Error(`Database config not found for tool: ${toolName}`);
							}
							if (!databaseName) {
								throw new Error('Database name must be provided');
							}

							const query = String(toolInput.query ?? '');
							const limit = typeof toolInput.limit === 'number' ? toolInput.limit : 10;
							onProgress?.(`Searching schema index: ${query} (${currentTool}/${toolCount})`);
							onDebugLog?.('tool', 'Schema Index', `Searching schema index for: ${query}`, `Tool: ${toolName}`);

							const index = await schemaIndexService.loadIndex(config.id);
							if (!index) {
								result = {
									exists : false,
									message: 'No local schema index found. Generate it in Settings → Database Connection → Database Schema Index.',
									databaseName,
								};
							} else {
								result = {
									exists        : true,
									databaseName,
									generatedAtIso: index.generatedAtIso,
									source        : index.source,
									matches       : schemaIndexService.searchSchema(index, query, limit),
								};
							}
						} else if (toolName.startsWith('get_table_schema_cached_')) {
							// Find which database this tool belongs to
							const configs = await databaseService.getConfigs();
							const config  = configs.find((c) => {
								const dbName = c.name.toLowerCase().replace(/\s+/g, '_');
								return toolName.includes(dbName);
							});

							if (!config) {
								throw new Error(`Database config not found for tool: ${toolName}`);
							}
							if (!databaseName) {
								throw new Error('Database name must be provided');
							}

							const tableName = String(toolInput.table_name ?? '');
							onProgress?.(`Reading schema index: ${tableName} (${currentTool}/${toolCount})`);
							onDebugLog?.('tool', 'Schema Index', `Reading cached schema for: ${tableName}`, `Tool: ${toolName}`);

							const index = await schemaIndexService.loadIndex(config.id);
							if (!index) {
								result = {
									exists : false,
									message: 'No local schema index found. Generate it in Settings → Database Connection → Database Schema Index.',
									databaseName,
								};
							} else {
								const table = schemaIndexService.getTable(index, tableName);
								if (!table) {
									result = {
										exists        : true,
										found         : false,
										databaseName,
										generatedAtIso: index.generatedAtIso,
										message       : `Table not found in local schema index: ${tableName}`,
									};
								} else {
									const maxColumns = 200;
									const columns    = table.columns.slice(0, maxColumns).map((c) => ({
										columnName     : c.columnName,
										dataType       : c.dataType,
										columnType     : c.columnType,
										ordinalPosition: c.ordinalPosition,
										isNullable     : c.isNullable,
									}));
									result           = {
										exists        : true,
										found         : true,
										databaseName,
										generatedAtIso: index.generatedAtIso,
										source        : index.source,
										table         : {
											tableName       : table.tableName,
											primaryKey      : table.primaryKey,
											foreignKeys     : table.foreignKeys,
											columns,
											columnsTruncated: table.columns.length > maxColumns,
										},
									};
								}
							}
						} else if (toolName.startsWith('describe_table_')) {
							// Find which database this tool belongs to
							const configs = await databaseService.getConfigs();
							const config  = configs.find((c) => {
								const dbName = c.name.toLowerCase().replace(/\s+/g, '_');
								return toolName.includes(dbName);
							});

							if (!config) {
								throw new Error(`Database config not found for tool: ${toolName}`);
							}

							const tableName = toolInput.table_name as string;
							onProgress?.(`Describing table: ${tableName} (${currentTool}/${toolCount})`);
							onDebugLog?.('query', 'Database Schema', `Describing table: ${tableName}`, `DESCRIBE ${tableName}`);
							result = await databaseService.getTableSchema(
								config.id,
								tableName,
								databaseName,
							);
							onDebugLog?.('query', 'Database Schema', `Table schema retrieved for ${tableName}`);
						}

						// Truncate large query results to prevent token limit errors
						const {truncated, data: processedResult} = this.truncateLargeToolResult(result);
						if (truncated) {
							onDebugLog?.('info', 'Query Truncation', `Large query result truncated to prevent token limit errors`);
						}

						toolResults.push({
							type       : 'tool_result',
							tool_use_id: content.id,
							content    : JSON.stringify(processedResult, null, 2),
						});
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : 'Unknown error';
						onDebugLog?.('error', 'Tool Error', `Error in ${toolName}: ${errorMessage}`, JSON.stringify(toolInput, null, 2));

						// Schema-aware hints for common SQL failures (reduces trial-and-error).
						// Uses the local schema index when available to avoid extra DB calls.
						if (toolName.startsWith('query_') && databaseName) {
							try {
								const configs = await databaseService.getConfigs();
								const config  = configs.find((c) => {
									const dbName = c.name.toLowerCase().replace(/\s+/g, '_');
									return toolName.includes(dbName);
								});

								if (config) {
									const hintPayload: any = {error: errorMessage};
									const index            = await schemaIndexService.loadIndex(config.id);
									if (index) {
										hintPayload.schemaIndex = {
											available     : true,
											generatedAtIso: index.generatedAtIso,
											source        : index.source,
										};

										const unknownColumnMatch = errorMessage.match(/Unknown column ['`"]([^'`"]+)['`"]/i);
										if (unknownColumnMatch) {
											const columnNeedle                                                  = unknownColumnMatch[1];
											const needleLower                                                   = columnNeedle.toLowerCase();
											const suggestions: Array<{ tableName: string; columnName: string }> = [];
											for (const t of index.tables) {
												for (const c of t.columns) {
													if (c.columnName.toLowerCase().includes(needleLower)) {
														suggestions.push({tableName: t.tableName, columnName: c.columnName});
														if (suggestions.length >= 25) {
															break;
														}
													}
												}
												if (suggestions.length >= 25) {
													break;
												}
											}
											hintPayload.hints               = hintPayload.hints || {};
											hintPayload.hints.unknownColumn = {
												requested: columnNeedle,
												suggestions,
											};
										}

										const tableDoesNotExistMatch = errorMessage.match(/Table ['`"]([^'`"]+)['`"] doesn't exist/i);
										if (tableDoesNotExistMatch) {
											const fullTableRef             = tableDoesNotExistMatch[1];
											const tableNeedle              = fullTableRef.includes('.') ? fullTableRef.split('.').pop()! : fullTableRef;
											hintPayload.hints              = hintPayload.hints || {};
											hintPayload.hints.unknownTable = {
												requested  : fullTableRef,
												suggestions: schemaIndexService.searchSchema(index, tableNeedle, 15),
											};
										}

										const ambiguousColumnMatch = errorMessage.match(/Column ['`"]([^'`"]+)['`"] in field list is ambiguous/i);
										if (ambiguousColumnMatch) {
											const col                         = ambiguousColumnMatch[1];
											hintPayload.hints                 = hintPayload.hints || {};
											hintPayload.hints.ambiguousColumn = {
												requested     : col,
												recommendation: 'Qualify the column with a table alias (e.g. t.column) or rename the selected column alias.',
												suggestions   : schemaIndexService.searchSchema(index, col, 10),
											};
										}
									} else {
										hintPayload.schemaIndex    = {available: false};
										hintPayload.recommendation = 'Generate the local schema index in Settings → Database Connection → Database Schema Index to get better hints and fewer schema queries.';
									}

									toolResults.push({
										type       : 'tool_result',
										tool_use_id: content.id,
										content    : JSON.stringify(hintPayload, null, 2),
										is_error   : true,
									});
									continue;
								}
							} catch (hintError) {
								onDebugLog?.('error', 'Tool Error', `Failed to generate schema hints for ${toolName}`, String(hintError));
							}
						}

						toolResults.push({
							type       : 'tool_result',
							tool_use_id: content.id,
							content    : `Error: ${errorMessage}`,
							is_error   : true,
						});
					}
				}
			}

			// Add assistant response and tool results to messages
			messages.push({
				role   : 'assistant',
				content: response.content,
			});

			messages.push({
				role   : 'user',
				content: toolResults,
			});

			// Get next response
			onProgress?.('Jørgen is thinking...');

			response = await client.messages.create({
				model     : 'claude-sonnet-4-5-20250929',
				max_tokens: 4096,
				system    : [
					{
						type         : 'text',
						text         : systemPrompt,
						cache_control: {type: 'ephemeral'},
					},
				],
				tools,
				messages,
				thinking  : {
					type         : 'enabled',
					budget_tokens: 2000,
				},
			});

			onProgress?.('Processing response...');
		}

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
					await this.exportToCsv(filename, largestResult.data);

					// Update the response to include CSV info
					// Extract text from current response
					const currentText = response.content
						.filter((c) => c.type === 'text')
						.map((c) => c.text)
						.join('\n');

					// Add CSV info to the messages
					messages.push({
						role   : 'assistant',
						content: currentText,
					});

					messages.push({
						role   : 'user',
						content: `A CSV file has been automatically created: ${filename} with ${largestResult.data.length} rows saved to the Downloads folder. Include this information in your answer.`,
					});

					// Get updated response that includes CSV info
					response = await client.messages.create({
						model     : 'claude-sonnet-4-5-20250929',
						max_tokens: 4096,
						messages,
					});
				} catch (error) {
					console.error('[ClaudeService] Failed to auto-export CSV:', error);
				}
			}
		}
		onProgress?.('Finishing answer...');

		// Start a fresh conversation for the simplification step
		// This avoids sending tool_use/tool_result blocks which can cause API errors
		const simplificationMessages: Anthropic.MessageParam[] = [];

		// Only add the conversation history (without tool blocks)
		if (conversationHistory && conversationHistory.length > 0) {
			for (const msg of conversationHistory) {
				simplificationMessages.push({
					role   : msg.role as 'user' | 'assistant',
					content: msg.content,
				});
			}
		}

		// Add the user's question
		simplificationMessages.push({
			role   : 'user',
			content: userMessage,
		});

		// Add Claude's technical response (extract text only, no tool_use blocks).
		// We will return this to the UI as the "detailed" answer.
		let detailedAnswer = response.content
			.filter((c) => c.type === 'text')
			.map((c) => c.text)
			.join('\n')
			.trim();

		// Only add the technical answer if it's not empty
		if (detailedAnswer) {
			simplificationMessages.push({
				role   : 'assistant',
				content: detailedAnswer,
			});
		} else {
			// If Claude didn't provide a text response (only used tools), ask for an answer first
			// Use the FULL messages array (with tool results) to get a complete answer
			messages.push({
				role   : 'user',
				content: 'Please provide a complete answer in the SAME LANGUAGE as the original question, based on all the data you gathered from the database queries.',
			});

			// Get the answer WITH access to all tool results
			const answerResponse = await client.messages.create({
				model     : 'claude-sonnet-4-5-20250929',
				max_tokens: 4096,
				system    : [
					{
						type         : 'text',
						text         : systemPrompt,
						cache_control: {type: 'ephemeral'},
					},
				],
				messages,
			});

			const answer = answerResponse.content
				.filter((c) => c.type === 'text')
				.map((c) => c.text)
				.join('\n');

			// Use this as the detailed answer when Claude produced only tool blocks before.
			detailedAnswer = answer.trim();

			simplificationMessages.push({
				role   : 'assistant',
				content: answer,
			});
		}

		// Ask Claude to rewrite it in clear language for support staff
		simplificationMessages.push({
			role   : 'user',
			content: `Now rewrite your answer for customer support staff in a clear and helpful way.

CRITICAL: Answer in the SAME LANGUAGE as the original question. If the question was in Danish, answer in Danish. If it was in English, answer in English.

OUTPUT LENGTH (VERY IMPORTANT):
- Default to a SHORT answer: maximum 3-4 lines total.
- If the user explicitly asks for details (steps, lists, deep explanation, code/SQL), you may go longer.
- If you cannot answer correctly in 3-4 lines, ask ONE clarifying question instead of writing a long answer.

Guidelines:
- Start with clear business language (customer, order, discount, price, invoice, delivery, etc.)
- Explain WHAT happens and WHY it matters, in as few words as possible
- Avoid unnecessary technical jargon
- BUT: If they ask for technical details (file names, class names, code locations, etc.), provide them directly
- If they ask "what file", "what class", "where in the code" - answer specifically with file paths and names
- Don't hide technical information when directly requested - support staff are capable of handling it
- If you created a CSV file, mention where it was saved

Balance: Be clear and accessible, but not dumbed down. Respect that support staff can handle technical details when needed.`,
		});

		// Get the simplified response (no tools needed here, CSV already created)
		const simplifiedResponse = await client.messages.create({
			model     : 'claude-sonnet-4-5-20250929',
			max_tokens: 600,
			messages  : simplificationMessages,
		});

		onProgress?.('Finalizing answer...');

		// Extract simplified answer (we will also update working summary).
		const simplifiedText = simplifiedResponse.content
			.filter((c) => c.type === 'text')
			.map((c) => c.text)
			.join('\n');

		// Update working summary in the background (best-effort).
		try {
			const updatePrompt = `You are maintaining a short "working summary" for an ongoing support chat.\n\nUpdate the existing summary using the latest user message and the assistant answer.\n\nRequirements:\n- Output plain text only (no JSON)\n- Max 12 bullet points total\n- Keep it factual and useful for future questions\n- Split into sections with short headers:\n  - Confirmed\n  - Assumptions\n  - Open questions\n- If a point is no longer true, remove it\n- If there is no existing summary, start a new one\n\nExisting summary:\n${workingSummaryText || '(none)'}\n\nLatest user message:\n${userMessage}\n\nAssistant answer:\n${simplifiedText}`;

			const summaryResponse = await client.messages.create({
				model     : 'claude-3-5-haiku-20241022',
				max_tokens: 512,
				messages  : [{role: 'user', content: updatePrompt}],
			});

			const summaryText = summaryResponse.content
				.filter((c) => c.type === 'text')
				.map((c) => c.text)
				.join('\n')
				.trim();

			if (summaryText) {
				await chatService.setWorkingSummary(chatId, summaryText);
				onDebugLog?.('info', 'Working Summary', 'Updated working summary', summaryText);
			}
		} catch (error) {
			onDebugLog?.('error', 'Working Summary', 'Failed to update working summary', String(error));
		}

		return {
			shortAnswer: simplifiedText,
			detailedAnswer,
		};
	}
}
