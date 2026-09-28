import OpenAI from 'openai';
import type {DatabaseService} from './database-service';
import type {GitHubService} from './github-service';
import type {SchemaIndexService} from './schema-index-service';
import type {ChatService} from './chat-service';
import type {AttachmentMeta, AttachmentService} from './attachment-service';
import {SecureStorageService} from './secure-storage-service';
import {
	exportToCsvFile,
	formatQueryDebugPreview,
	preflightQueryAgainstSchemaIndex,
	runWithConcurrency,
	truncateLargeToolResult,
} from './claude-tools';
import {createOpenAITools} from './openai-tools';
import {
	dedupeCodeSearchResults as dedupeOpenAiCodeSearchResults,
	dedupeUiSearchResults as dedupeOpenAiUiSearchResults,
	enrichUiSearchResultsWithContext as enrichOpenAiUiSearchResultsWithContext,
	formatGroundingDebugPreview as formatOpenAiGroundingDebugPreview,
	formatIntegrationCodeSearchResults as formatOpenAiIntegrationCodeSearchResults,
	formatToolsCodeSearchResults as formatOpenAiToolsCodeSearchResults,
	formatUiCodeSearchResults as formatOpenAiUiCodeSearchResults,
} from './openai/openai-context';
import {
	buildOpenAiCompletionPrompt,
	buildOpenAiCoreSystemPrompt,
	buildOpenAiRetryPrompt,
	buildOpenAiSimplificationPrompt,
} from './openai/openai-prompts';
import {decideOpenAiCompletionPass, decideOpenAiTechnicalRetry} from './openai/openai-quality';
import {createOpenAIProvider} from './providers/openai-provider';
import type {AiQualityProfile} from './settings-service';
import {createEventForwarder} from './shared/event-forwarder';
import {VectorStoreService} from './vector-store-service';
import {LATENCY_FLAGS} from './latency-flags';
import {detectTextClarification} from './shared/clarification-detector';
import {buildFollowUpRetrievalQuery, compactConversationHistory, formatRecentConversationForSummary} from './shared/context-builder';
import {buildContextBudget} from './shared/context-budget';
import {
	buildIntentProfile,
	buildToolsScriptQueries as buildSharedToolsScriptQueries,
	buildUiGroundingQueries as buildSharedUiGroundingQueries,
	extractSearchKeywords as extractSharedSearchKeywords,
} from './shared/intent-profile';
import {loadPromptAsset} from './shared/prompt-asset-loader';
import {
	addAnswerEvidence,
	formatAnswerEvidenceSummary,
} from './shared/answer-quality';
import type {AnswerEvidenceItem} from './shared/answer-quality';
import type {SpyCodeAiMcpService} from './spy-code-ai-mcp-service';

const OPENAI_MODEL                                     = 'gpt-5.5';
const MAX_PARALLEL_TOOL_CALLS                          = 3;
const DEFAULT_OPENAI_QUALITY_PROFILE: AiQualityProfile = 'maximum_accuracy';
const SPY_CODE_AI_PROMPT_ASSET                         = 'spy-code-ai-chatbot.mdc';

type LatencyPhase = 'prepare' | 'prompt_build' | 'retrieval' | 'technical' | 'postprocess' | 'total';

interface OpenAiQualityConfig {
	agentMaxIterations: number;
	maxTokens: number;
	completionMaxTokens: number;
	simplificationMaxTokens: number;
	reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	reasoningSummary: 'auto' | 'concise' | 'detailed';
}

type OpenAiChatMessage =
	| { role: 'system'; content: string }
	| { role: 'user'; content: string | OpenAI.Chat.Completions.ChatCompletionContentPart[] }
	| { role: 'assistant'; content: string | null; tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] }
	| { role: 'tool'; tool_call_id: string; content: string };

function convertOpenAiMessagesToTanStack(
	messages: OpenAiChatMessage[],
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
	return messages
		.filter((m): m is Exclude<OpenAiChatMessage, { role: 'system' } | {
			role: 'tool';
			tool_call_id: string;
			content: string
		}> => m.role === 'user' || m.role === 'assistant')
		.map((m) => {
			if (typeof m.content === 'string' || m.content === null) {
				return {role: m.role, content: m.content || ''};
			}
			const parts = m.content
				.map((part) => {
					if (part.type === 'text') {
						return {type: 'text', content: part.text};
					}
					if (part.type === 'image_url') {
						const imageUrl  = part.image_url?.url || '';
						const dataMatch = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
						if (dataMatch) {
							return {
								type  : 'image',
								source: {
									type    : 'data',
									value   : dataMatch[2],
									mimeType: dataMatch[1],
								},
							};
						}
						if (imageUrl) {
							return {
								type  : 'image',
								source: {
									type : 'url',
									value: imageUrl,
								},
							};
						}
					}
					return null;
				})
				.filter(Boolean) as Array<{ type: string; content?: string; source?: { type: 'url' | 'data'; value: string; mimeType?: string } }>;
			return {role: m.role, content: parts.length > 0 ? parts : ''};
		});
}

interface ToolContext {
	databaseService: DatabaseService;
	githubService: GitHubService;
	schemaIndexService: SchemaIndexService;
	spyCodeAiMcpService: SpyCodeAiMcpService;
	databaseIds: string[];
	databaseName?: string;
	dbHostOverride?: string;
	githubBranchOverride?: string;
	onProgress?: (status: string) => void;
	onDebugLog?: (type: 'query' | 'tool' | 'api' | 'error' | 'info', category: string, message: string, details?: string) => void;
	queryResults: Array<{ query: string; data: any[] }>;
	evidenceItems: AnswerEvidenceItem[];
	toolUsageStats: {
		codeSearches: number;
		contextSearches: number;
		fileReads: number;
		fileSectionReads: number;
	};
	dbConfigById: Map<string, { id: string; name: string; host: string; database?: string }>;
	allowedDbDisplay: string;
	hasGitHub: boolean;
	localRepoUrl: string | null;
	githubConfig: { branch: string } | null;
}

export class OpenAIService {
	private apiKeyCache: string | null             = null;
	private vectorStore: VectorStoreService | null = null;

	constructor(private readonly secureStorage: SecureStorageService) {
		// Warm up vector store in background to reduce first-request latency.
		void this.ensureVectorStore();
	}

	private async ensureVectorStore(): Promise<VectorStoreService | null> {
		if (this.vectorStore) {
			return this.vectorStore;
		}
		try {
			this.vectorStore = new VectorStoreService();
			await this.vectorStore.initialize();
			return this.vectorStore;
		} catch {
			return null;
		}
	}

	async getApiKey(): Promise<string | null> {
		const key = await this.secureStorage.loadEncrypted('openai-api-key');
		return key ? key.trim() : null;
	}

	async saveApiKey(apiKey: string): Promise<void> {
		const trimmedKey = apiKey.trim();
		if (!trimmedKey.startsWith('sk-')) {
			throw new Error('Invalid OpenAI API key format. Must start with "sk-"');
		}
		await this.secureStorage.saveEncrypted('openai-api-key', trimmedKey);
		this.apiKeyCache = trimmedKey;
	}

	private async ensureApiKey(): Promise<string> {
		if (this.apiKeyCache) {
			return this.apiKeyCache;
		}
		const apiKey = await this.getApiKey();
		if (!apiKey) {
			throw new Error('OpenAI API key not configured. Please add your OpenAI API key in Settings.');
		}
		this.apiKeyCache = apiKey;
		return apiKey;
	}

	private async buildTools(ctx: ToolContext): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]> {
		const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];

		if (ctx.databaseName && ctx.databaseIds.length > 0) {
			const dbIdParam = {
				type       : 'string' as const,
				enum       : ctx.databaseIds,
				description: `Database connection UUID. Use exactly: ${ctx.allowedDbDisplay}`,
			};

			tools.push({
				type    : 'function',
				function: {
					name       : 'get_table_schema_cached',
					description: 'REQUIRED before query_database! Get exact column names for a table from the schema index. Returns all columns with their types. Use this to verify column names before writing any SQL query.',
					parameters : {
						type      : 'object',
						properties: {
							dbId      : dbIdParam,
							table_name: {type: 'string', description: 'Exact table name'},
						},
						required  : ['dbId', 'table_name'],
					},
				},
			});

			tools.push({
				type    : 'function',
				function: {
					name       : 'search_schema',
					description: 'Find table names by keyword. Use FIRST when you need to find which table contains certain data.',
					parameters : {
						type      : 'object',
						properties: {
							dbId : dbIdParam,
							query: {type: 'string', description: 'Keyword to search for'},
							limit: {type: 'number', description: 'Max results to return'},
						},
						required  : ['dbId', 'query'],
					},
				},
			});

			tools.push({
				type    : 'function',
				function: {
					name       : 'list_tables',
					description: 'List all tables for a database.',
					parameters : {
						type      : 'object',
						properties: {
							dbId: dbIdParam,
						},
						required  : ['dbId'],
					},
				},
			});

			tools.push({
				type    : 'function',
				function: {
					name       : 'describe_table',
					description: 'Get live schema information for a table from the database.',
					parameters : {
						type      : 'object',
						properties: {
							dbId      : dbIdParam,
							table_name: {type: 'string', description: 'Table name'},
						},
						required  : ['dbId', 'table_name'],
					},
				},
			});

			tools.push({
				type    : 'function',
				function: {
					name       : 'query_database',
					description: 'Execute a READ-ONLY SQL query. MANDATORY: Before using this tool, you MUST call search_schema to find the correct table name AND get_table_schema_cached to verify exact column names. NEVER guess table or column names.',
					parameters : {
						type      : 'object',
						properties: {
							dbId : dbIdParam,
							query: {type: 'string', description: 'SELECT/SHOW/DESCRIBE/EXPLAIN query. Always use LIMIT for large result sets.'},
						},
						required  : ['dbId', 'query'],
					},
				},
			});

			tools.push({
				type    : 'function',
				function: {
					name       : 'export_to_csv',
					description: 'Export query results to a CSV file in the Downloads folder.',
					parameters : {
						type      : 'object',
						properties: {
							dbId    : dbIdParam,
							query   : {type: 'string', description: 'SQL query to export'},
							filename: {type: 'string', description: 'File name without .csv extension'},
						},
						required  : ['dbId', 'query', 'filename'],
					},
				},
			});
		}

		if (ctx.hasGitHub) {
			tools.push({
				type    : 'function',
				function: {
					name       : 'search_code',
					description: 'Search repository code. Use for "how does X work", UI navigation, feature logic, error causes. Supports path: or file: prefixes.',
					parameters : {
						type      : 'object',
						properties: {
							query: {type: 'string', description: 'Search query. Supports path:folder or file:name.php prefixes.'},
						},
						required  : ['query'],
					},
				},
			});

			tools.push({
				type    : 'function',
				function: {
					name       : 'search_code_context',
					description: 'PREFERRED for understanding code. Returns actual source snippets with line numbers. Use for "how to", "where is the setting", understanding feature logic.',
					parameters : {
						type      : 'object',
						properties: {
							query        : {type: 'string', description: 'Search query. Supports path:folder or file:name.php prefixes.'},
							max_files    : {type: 'number', description: 'Max files to return snippets from (default: 3, max: 5)'},
							context_lines: {type: 'number', description: 'Lines of context around each match (default: 40, max: 120)'},
						},
						required  : ['query'],
					},
				},
			});

			tools.push({
				type    : 'function',
				function: {
					name       : 'read_file',
					description: 'Read an ENTIRE file from the repository. For large files (1000+ lines), prefer read_file_section.',
					parameters : {
						type      : 'object',
						properties: {
							file_path: {type: 'string', description: 'Path to the file in the repository'},
						},
						required  : ['file_path'],
					},
				},
			});

			tools.push({
				type    : 'function',
				function: {
					name       : 'read_file_section',
					description: 'Read a specific section of a file by line range. Much more efficient than read_file for large files.',
					parameters : {
						type      : 'object',
						properties: {
							file_path : {type: 'string', description: 'Path to the file in the repository'},
							start_line: {type: 'number', description: 'First line to read (1-based)'},
							end_line  : {type: 'number', description: 'Last line to read (1-based). Max range: 300 lines.'},
						},
						required  : ['file_path', 'start_line', 'end_line'],
					},
				},
			});

			tools.push({
				type    : 'function',
				function: {
					name       : 'list_files',
					description: 'List files in a directory in the configured repository.',
					parameters : {
						type      : 'object',
						properties: {
							directory_path: {type: 'string', description: 'Directory path'},
						},
						required  : ['directory_path'],
					},
				},
			});

			tools.push({
				type    : 'function',
				function: {
					name       : 'get_repository_structure',
					description: 'Get the complete file tree structure of the repository.',
					parameters : {
						type      : 'object',
						properties: {},
					},
				},
			});
		}

		if (await ctx.spyCodeAiMcpService.isConfigured()) {
			tools.push({
				type    : 'function',
				function: {
					name       : 'spy_search_code',
					description: 'Search indexed SPY code by semantic or symbolic query. Use for broad SPY monolith lookup, then verify important claims with direct file reads when available.',
					parameters : {
						type      : 'object',
						properties: {
							query     : {type: 'string', description: 'What to search for in indexed SPY code'},
							kind      : {
								type       : 'string',
								enum       : ['entity_field', 'class', 'method', 'sql_query', 'route', 'relation', 'ts_file', 'view', 'api_endpoint'],
								description: 'Optional type filter',
							},
							limit     : {type: 'number', description: 'Max results to return (1-50)'},
							match_mode: {
								type       : 'string',
								enum       : ['auto', 'semantic', 'symbolic', 'hybrid'],
								description: 'Optional search strategy',
							},
						},
						required  : ['query'],
					},
				},
			});

			tools.push({
				type    : 'function',
				function: {
					name       : 'spy_search_context',
					description: 'Retrieve indexed SPY implementation context grouped by data, logic, API, UI, and relationships. Use for feature overviews and flow discovery.',
					parameters : {
						type      : 'object',
						properties: {
							query: {type: 'string', description: 'Natural language description of the feature area'},
							limit: {type: 'number', description: 'Max results per layer (1-50)'},
						},
						required  : ['query'],
					},
				},
			});
		}

		tools.push({
			type    : 'function',
			function: {
				name       : 'ask_clarifying_question',
				description: 'Ask the user a clarifying question to give a better answer. Use freely when context would help. Provide 2-4 options when possible.',
				parameters : {
					type      : 'object',
					properties: {
						question     : {type: 'string', description: "The clarifying question in the user's language"},
						options      : {
							type       : 'array',
							items      : {type: 'string'},
							description: '2-4 suggested answers',
						},
						allowFreeText: {type: 'boolean', description: 'If true, show a text field for custom input'},
					},
					required  : ['question'],
				},
			},
		});

		return tools;
	}

	private async executeTool(toolName: string, args: any, ctx: ToolContext): Promise<any> {
		const {
				  databaseService, githubService, schemaIndexService,
				  databaseName, dbHostOverride, githubBranchOverride,
				  onProgress, onDebugLog, queryResults, evidenceItems, toolUsageStats,
				  dbConfigById, allowedDbDisplay, localRepoUrl, githubConfig, spyCodeAiMcpService,
			  }                        = ctx;
		const schemaBranch             = githubBranchOverride?.trim() || githubConfig?.branch?.trim() || undefined;
		const schemaIndexLookupOptions = {
			branch          : schemaBranch,
			fallbackBranches: githubConfig?.branch ? [githubConfig.branch] : [],
		};

		const ensureDbConfig = (dbId: string) => dbConfigById.get(dbId) || null;

		switch (toolName) {
			case 'get_table_schema_cached': {
				const {dbId, table_name} = args;
				const config             = ensureDbConfig(dbId);
				if (!config) return {error: `Database not available: ${dbId}. Allowed: ${allowedDbDisplay}`};
				if (!databaseName) return {error: 'Database name must be provided'};

				onProgress?.(`Reading schema index: ${table_name}`);
				onDebugLog?.('tool', 'Schema Index', `Reading cached schema for: ${table_name}`);

				const index = await schemaIndexService.loadIndex(config.id, schemaIndexLookupOptions);
				if (!index) {
					return {
						exists : false,
						message: schemaBranch
							? `No local schema index found for branch "${schemaBranch}". Generate it in Settings → Database Connection → Database Schema Index, or rely on the fallback/global index.`
							: 'No local schema index found. Generate it in Settings → Database Connection → Database Schema Index.',
					};
				}

				const table = schemaIndexService.getTable(index, table_name);
				if (!table) {
					return {
						exists        : true,
						found         : false,
						databaseName,
						generatedAtIso: index.generatedAtIso,
						message       : `Table not found: ${table_name}`,
					};
				}

				const columns = table.columns.slice(0, 200).map((c: any) => ({
					columnName     : c.columnName, dataType: c.dataType, columnType: c.columnType,
					ordinalPosition: c.ordinalPosition, isNullable: c.isNullable,
				}));
				addAnswerEvidence(evidenceItems, {
					kind    : 'schema_lookup',
					label   : table.tableName,
					detail  : `cached schema with ${table.columns.length} columns`,
					verified: true,
				});
				return {
					exists        : true,
					found         : true,
					databaseName,
					generatedAtIso: index.generatedAtIso,
					branch        : index.branch,
					source        : index.source,
					table         : {tableName: table.tableName, primaryKey: table.primaryKey, foreignKeys: table.foreignKeys, columns},
				};
			}

			case 'search_schema': {
				const {dbId, query, limit} = args;
				const config               = ensureDbConfig(dbId);
				if (!config) return {error: `Database not available: ${dbId}. Allowed: ${allowedDbDisplay}`};
				if (!databaseName) return {error: 'Database name must be provided'};

				onProgress?.(`Searching schema: ${query}`);
				onDebugLog?.('tool', 'Schema Index', `Searching schema for: ${query}`);

				const index = await schemaIndexService.loadIndex(config.id, schemaIndexLookupOptions);
				if (!index) {
					return {
						exists : false,
						message: schemaBranch
							? `No local schema index found for branch "${schemaBranch}".`
							: 'No local schema index found.',
					};
				}
				const matches = schemaIndexService.searchSchema(index, query, limit ?? 10);
				addAnswerEvidence(evidenceItems, {
					kind       : 'schema_lookup',
					label      : `search_schema("${query}")`,
					resultCount: matches.length,
					verified   : matches.length > 0,
				});
				return {
					exists        : true,
					databaseName,
					generatedAtIso: index.generatedAtIso,
					branch        : index.branch,
					matches,
				};
			}

			case 'list_tables': {
				const {dbId} = args;
				const config = ensureDbConfig(dbId);
				if (!config) return {error: `Database not available: ${dbId}. Allowed: ${allowedDbDisplay}`};
				if (!databaseName) return {error: 'Database name must be provided'};

				onProgress?.(`Listing tables in ${config.name}`);
				onDebugLog?.('query', 'Database Schema', `Listing tables in ${databaseName}`);
				const result = await databaseService.listTables(config.id, databaseName, dbHostOverride);
				addAnswerEvidence(evidenceItems, {
					kind       : 'schema_lookup',
					label      : `list_tables(${databaseName})`,
					resultCount: Array.isArray(result) ? result.length : undefined,
					verified   : Array.isArray(result) && result.length > 0,
				});
				return result;
			}

			case 'describe_table': {
				const {dbId, table_name} = args;
				const config             = ensureDbConfig(dbId);
				if (!config) return {error: `Database not available: ${dbId}. Allowed: ${allowedDbDisplay}`};

				onProgress?.(`Describing table: ${table_name}`);
				onDebugLog?.('query', 'Database Schema', `Describing table: ${table_name}`);
				const result = await databaseService.getTableSchema(config.id, table_name, databaseName, dbHostOverride);
				addAnswerEvidence(evidenceItems, {
					kind       : 'schema_lookup',
					label      : `describe_table(${table_name})`,
					resultCount: Array.isArray(result) ? result.length : undefined,
					verified   : Array.isArray(result) ? result.length > 0 : true,
				});
				return result;
			}

			case 'query_database': {
				const {dbId, query} = args;
				const config        = ensureDbConfig(dbId);
				if (!config) return {error: `Database not available: ${dbId}. Allowed: ${allowedDbDisplay}`};
				if (!databaseName) return {error: 'Database name must be provided'};

				const shortQuery = query.length > 60 ? `${query.substring(0, 60)}...` : query;
				onProgress?.(`Running query: ${shortQuery}`);
				onDebugLog?.('query', 'Database Query', `Executing query on ${databaseName}`, query);

				const preflight = await preflightQueryAgainstSchemaIndex(schemaIndexService, config.id, query, schemaIndexLookupOptions);
				if (!preflight.ok) {
					return {
						error         : preflight.error,
						hints         : preflight.hints,
						recommendation: 'Use get_table_schema_cached FIRST to verify column names.',
					};
				}

				const result    = await databaseService.executeQuery(config.id, query, databaseName, dbHostOverride);
				const resultObj = result as { rows?: any[]; rowCount?: number };
				const rowCount  = typeof resultObj.rowCount === 'number'
					? resultObj.rowCount
					: (Array.isArray(resultObj.rows) ? resultObj.rows.length : undefined);
				if (resultObj.rows && resultObj.rows.length > 0) {
					queryResults.push({query, data: resultObj.rows});
				}
				addAnswerEvidence(evidenceItems, {
					kind    : 'database_query',
					label   : query,
					rowCount,
					verified: true,
				});
				onDebugLog?.(
					'query',
					'Database Query',
					`Query completed - ${resultObj.rowCount || 0} rows`,
					formatQueryDebugPreview(result),
				);
				return truncateLargeToolResult(result).data;
			}

			case 'export_to_csv': {
				const {dbId, query, filename} = args;
				const config                  = ensureDbConfig(dbId);
				if (!config) return {error: `Database not available: ${dbId}. Allowed: ${allowedDbDisplay}`};
				if (!databaseName) return {error: 'Database name must be provided'};

				onProgress?.(`Exporting to CSV: ${filename}.csv`);
				onDebugLog?.('tool', 'CSV Export', `Exporting to ${filename}.csv`);

				const queryResult    = await databaseService.executeQuery(config.id, query, databaseName, dbHostOverride);
				const queryResultObj = queryResult as { rows?: any[]; rowCount?: number };
				if (!queryResultObj.rows || queryResultObj.rows.length === 0) {
					return {error: 'Query returned no data to export'};
				}
				addAnswerEvidence(evidenceItems, {
					kind    : 'csv_export',
					label   : `${filename}.csv`,
					rowCount: queryResultObj.rows.length,
					verified: true,
				});

				const now          = new Date();
				const dateStr      = now.toISOString().split('T')[0];
				const timeStr      = now.toTimeString().split(' ')[0].replace(/:/g, '-');
				const fullFilename = `${filename}_${dateStr}_${timeStr}.csv`;
				return await exportToCsvFile(fullFilename, queryResultObj.rows);
			}

			case 'search_code': {
				const {query} = args;
				toolUsageStats.codeSearches += 1;
				onProgress?.(`Searching code: ${query.substring(0, 40)}...`);
				onDebugLog?.('tool', 'Repository', `Searching code: ${query}`);

				if (localRepoUrl) {
					const branch = githubBranchOverride?.trim() || githubConfig?.branch || 'main';
					try {
						const result = await githubService.searchCodeLocal(query, branch, localRepoUrl);
						addAnswerEvidence(evidenceItems, {
							kind       : 'code_search',
							label      : query,
							resultCount: Array.isArray(result) ? result.length : undefined,
							detail     : `local repo branch ${branch}`,
							verified   : false,
						});
						return truncateLargeToolResult(result).data;
					} catch (error) {
						onDebugLog?.('error', 'Repository', 'Local repository search failed', String(error));
						return {error: `Local repository search failed: ${String(error)}. Remote fallback is disabled while Local Git Sync is configured.`};
					}
				}
				const result = await githubService.searchCode(query, githubBranchOverride);
				addAnswerEvidence(evidenceItems, {
					kind       : 'code_search',
					label      : query,
					resultCount: Array.isArray(result) ? result.length : undefined,
					detail     : githubBranchOverride ? `branch ${githubBranchOverride}` : undefined,
					verified   : false,
				});
				return truncateLargeToolResult(result).data;
			}

			case 'spy_search_code': {
				toolUsageStats.codeSearches += 1;
				onProgress?.(`Searching indexed SPY code: ${String(args?.query || '').substring(0, 40)}...`);
				onDebugLog?.('tool', 'Spy Code AI MCP', `Searching indexed code: ${String(args?.query || '')}`, 'Tool: spy_search_code');
				const raw = await spyCodeAiMcpService.searchCode(args);
				addAnswerEvidence(evidenceItems, {
					kind       : 'mcp_index',
					label      : String(args?.query || ''),
					resultCount: Array.isArray(raw) ? raw.length : undefined,
					detail     : 'spy_search_code indexed result',
					verified   : false,
				});
				return truncateLargeToolResult(raw).data;
			}

			case 'spy_search_context': {
				toolUsageStats.contextSearches += 1;
				onProgress?.(`Searching indexed SPY context: ${String(args?.query || '').substring(0, 40)}...`);
				onDebugLog?.('tool', 'Spy Code AI MCP', `Searching indexed context: ${String(args?.query || '')}`, 'Tool: spy_search_context');
				const raw = await spyCodeAiMcpService.searchContext(args);
				addAnswerEvidence(evidenceItems, {
					kind       : 'mcp_index',
					label      : String(args?.query || ''),
					resultCount: Array.isArray(raw) ? raw.length : undefined,
					detail     : 'spy_search_context indexed result',
					verified   : false,
				});
				return truncateLargeToolResult(raw).data;
			}

			case 'search_code_context': {
				const {query, max_files, context_lines} = args;
				const maxFiles                          = typeof max_files === 'number' ? Math.min(max_files, 5) : 3;
				const ctxLines                          = typeof context_lines === 'number' ? Math.min(context_lines, 120) : 40;
				toolUsageStats.contextSearches += 1;

				onProgress?.(`Searching code context: ${query.substring(0, 40)}...`);
				onDebugLog?.('tool', 'Repository', `Searching code context: ${query}`);

				const branch = githubBranchOverride?.trim() || githubConfig?.branch || 'main';
				const url    = localRepoUrl || githubService.getLocalRepoUrl();
				if (!url) {
					return {error: 'Local repository is not configured. Configure Local Git Sync in Settings.'};
				}

				const results                                            = await githubService.searchCodeLocal(query, branch, url);
				const contexts: Array<{ path: string; excerpt: string }> = [];
				for (const r of results.slice(0, maxFiles)) {
					const firstMatch = (r.matches && r.matches.length > 0) ? String(r.matches[0]) : '';
					const m          = firstMatch.match(/^(\d+):\s*/);
					const line       = m ? Number.parseInt(m[1], 10) : 1;
					const start      = Math.max(1, line - ctxLines);
					const end        = line + ctxLines;
					const excerpt    = await githubService.readFileLocalSnippet(r.path, branch, url, start, end);
					contexts.push({path: r.path, excerpt});
				}
				addAnswerEvidence(evidenceItems, {
					kind       : 'code_context',
					label      : query,
					resultCount: contexts.length,
					detail     : contexts.map((c) => c.path).join(', '),
					verified   : contexts.length > 0,
				});
				return contexts;
			}

			case 'read_file': {
				const {file_path} = args;
				toolUsageStats.fileReads += 1;
				onProgress?.(`Reading file: ${file_path}`);
				onDebugLog?.('tool', 'Repository', `Reading file: ${file_path}`);

				const branch = githubBranchOverride?.trim() || githubConfig?.branch || 'main';
				const url    = localRepoUrl || githubService.getLocalRepoUrl();
				if (url) {
					try {
						const content = await githubService.readFileLocalSnippet(file_path, branch, url, 1, 9999);
						addAnswerEvidence(evidenceItems, {
							kind    : 'file_read',
							label   : file_path,
							detail  : `local repo branch ${branch}`,
							verified: true,
						});
						return truncateLargeToolResult(content).data;
					} catch {
						// fallback to GitHub API
					}
				}
				const result = await githubService.getFileContent(file_path, undefined, githubBranchOverride);
				addAnswerEvidence(evidenceItems, {
					kind    : 'file_read',
					label   : file_path,
					detail  : githubBranchOverride ? `branch ${githubBranchOverride}` : undefined,
					verified: typeof result === 'string' && result.length > 0,
				});
				return truncateLargeToolResult(result).data;
			}

			case 'read_file_section': {
				const {file_path, start_line, end_line} = args;
				const clampedEnd                        = Math.min(end_line, start_line + 300);
				toolUsageStats.fileSectionReads += 1;
				onProgress?.(`Reading ${file_path}:${start_line}-${clampedEnd}`);
				onDebugLog?.('tool', 'Repository', `Reading file section: ${file_path} lines ${start_line}-${clampedEnd}`);

				const branch = githubBranchOverride?.trim() || githubConfig?.branch || 'main';
				const url    = localRepoUrl || githubService.getLocalRepoUrl();
				if (url) {
					const excerpt = await githubService.readFileLocalSnippet(file_path, branch, url, start_line, clampedEnd);
					addAnswerEvidence(evidenceItems, {
						kind    : 'file_read',
						label   : file_path,
						detail  : `lines ${start_line}-${clampedEnd}`,
						verified: true,
					});
					return {file: file_path, lines: `${start_line}-${clampedEnd}`, content: excerpt};
				}
				const fullContent = await githubService.getFileContent(file_path, undefined, githubBranchOverride);
				if (typeof fullContent === 'string') {
					const lines = fullContent.split('\n');
					addAnswerEvidence(evidenceItems, {
						kind    : 'file_read',
						label   : file_path,
						detail  : `lines ${start_line}-${clampedEnd}`,
						verified: true,
					});
					return {
						file   : file_path,
						lines  : `${start_line}-${clampedEnd}`,
						total  : lines.length,
						content: lines.slice(start_line - 1, clampedEnd).join('\n'),
					};
				}
				return {error: 'Could not read file'};
			}

			case 'list_files': {
				const {directory_path} = args;
				onProgress?.(`Listing files: ${directory_path}`);
				onDebugLog?.('tool', 'Repository', `Listing files: ${directory_path}`);
				const result = await githubService.listFiles(directory_path, githubBranchOverride);
				addAnswerEvidence(evidenceItems, {
					kind       : 'code_search',
					label      : `list_files(${directory_path || '/'})`,
					resultCount: Array.isArray(result) ? result.length : undefined,
					verified   : false,
				});
				return result;
			}

			case 'get_repository_structure': {
				onProgress?.('Getting repository structure...');
				onDebugLog?.('tool', 'Repository', 'Getting repository structure');
				const result = await githubService.getTree(true, githubBranchOverride);
				addAnswerEvidence(evidenceItems, {
					kind       : 'code_search',
					label      : 'get_repository_structure',
					resultCount: Array.isArray(result) ? result.length : undefined,
					verified   : false,
				});
				return result;
			}

			default:
				return {error: `Unknown tool: ${toolName}`};
		}
	}

	private async runTanStackTechnicalPhase(
		messages: OpenAiChatMessage[],
		systemPrompt: string,
		apiKey: string,
		qualityConfig: OpenAiQualityConfig,
		ctx: ToolContext,
		onDebugLog?: (type: 'query' | 'tool' | 'api' | 'error' | 'info', category: string, message: string, details?: string) => void,
		onEvent?: (event: unknown) => void,
		abortController?: AbortController,
	): Promise<{
		detailedAnswer: string;
		clarificationRequest: null | { question: string; options?: string[]; allowFreeText?: boolean };
		agentLoopExhausted: boolean;
	}> {
		const [{chat, maxIterations}]                                                                      = await Promise.all([import('@tanstack/ai')]);
		const provider                                                                                     = await createOpenAIProvider(apiKey);
		const {tools}                                                                                      = await createOpenAITools({
			databaseService     : ctx.databaseService,
			githubService       : ctx.githubService,
			schemaIndexService  : ctx.schemaIndexService,
			spyCodeAiMcpService : ctx.spyCodeAiMcpService,
			databaseIds         : ctx.databaseIds,
			databaseName        : ctx.databaseName,
			dbHostOverride      : ctx.dbHostOverride,
			githubBranchOverride: ctx.githubBranchOverride,
			onProgress          : ctx.onProgress,
			onDebugLog          : ctx.onDebugLog,
			queryResults        : ctx.queryResults,
			evidenceItems       : ctx.evidenceItems,
			toolUsageStats      : ctx.toolUsageStats,
		});
		const eventForwarder                                                                               = createEventForwarder(onEvent);
		let detailedAnswer                                                                                 = '';
		let clarificationRequest: null | { question: string; options?: string[]; allowFreeText?: boolean } = null;
		let agentLoopExhausted                                                                             = false;
		const stream                                                                                       = chat({
			adapter          : provider.createAdapter(OPENAI_MODEL) as any,
			messages         : convertOpenAiMessagesToTanStack(messages) as any,
			tools            : tools as any,
			systemPrompts    : [systemPrompt],
			agentLoopStrategy: maxIterations(qualityConfig.agentMaxIterations),
			maxTokens        : qualityConfig.maxTokens,
			modelOptions     : {
				reasoning: {
					effort : qualityConfig.reasoningEffort,
					summary: qualityConfig.reasoningSummary,
				},
			},
			abortController,
		});
		for await (const event of stream as AsyncIterable<any>) {
			if (event?.type === 'TEXT_MESSAGE_CONTENT' && typeof event.delta === 'string') {
				detailedAnswer += event.delta;
				eventForwarder.forward(event);
				continue;
			}
			if (event?.type === 'TOOL_CALL_END' && event.toolName === 'ask_clarifying_question' && event.result) {
				const parsed = typeof event.result === 'string' ? (() => {
					try {
						return JSON.parse(event.result);
					} catch {
						return null;
					}
				})() : event.result;
				if (parsed && (parsed as any).__clarificationRequest) {
					clarificationRequest = {
						question     : (parsed as any).question,
						options      : (parsed as any).options,
						allowFreeText: (parsed as any).allowFreeText !== false,
					};
					break;
				}
			}
			if (event?.type === 'RUN_ERROR') {
				onDebugLog?.('error', 'OpenAI TanStack', 'Run error', String(event.error?.message || 'Unknown error'));
			}
			if (event?.type === 'RUN_FINISHED') {
				const reason = String(event.finishReason || 'unknown');
				if (reason === 'max_turns' || reason === 'maxIterations' || reason === 'max_iterations') {
					agentLoopExhausted = true;
				}
			}
			eventForwarder.forward(event);
		}
		onDebugLog?.('info', 'OpenAI TanStack', `Technical phase complete, answer length: ${detailedAnswer.length}`);
		return {detailedAnswer: detailedAnswer.trim(), clarificationRequest, agentLoopExhausted};
	}

	async sendMessage(
		chatId: string,
		userMessage: string,
		databaseIds: string[],
		databaseService: DatabaseService,
		githubService: GitHubService,
		schemaIndexService: SchemaIndexService,
		spyCodeAiMcpService: SpyCodeAiMcpService,
		chatService: ChatService,
		attachmentService: AttachmentService,
		onProgress?: (status: string) => void,
		conversationHistory?: Array<{ role: string; content: string }>,
		databaseName?: string,
		dbHostOverride?: string,
		githubBranchOverride?: string,
		attachments?: AttachmentMeta[],
		aiQualityProfile: AiQualityProfile = DEFAULT_OPENAI_QUALITY_PROFILE,
		onDebugLog?: (type: 'query' | 'tool' | 'api' | 'error' | 'info', category: string, message: string, details?: string) => void,
		_onEvent?: (event: unknown) => void,
		abortController?: AbortController,
	): Promise<{ shortAnswer: string; detailedAnswer: string; suggestedTitle?: string } | {
		needsClarification: true;
		question: string;
		options?: string[];
		allowFreeText?: boolean
	}> {
		const requestStartMs           = Date.now();
		const effectiveQualityProfile  = normalizeOpenAiQualityProfile(aiQualityProfile);
		const qualityConfig            = getOpenAiQualityConfig(effectiveQualityProfile);
		const intent                   = buildIntentProfile(userMessage);
		const contextBudget            = buildContextBudget(intent);
		const desiredDetailLevel       = intent.desiredDetailLevel;
		const isToolsOrScriptQuestion  = intent.isToolsOrScriptQuestion;
		const isUiQuestion             = intent.isUiQuestion;
		const hasConcreteIdentifier    = intent.hasConcreteIdentifier;
		const requiresCodeFirst        = intent.requiresCodeFirst;
		const requiresHandlerNav       = intent.requiresHandlerNav;
		const requiresDatabase         = intent.requiresDatabase;
		const requiresIntegrationFocus = intent.requiresIntegrationFocus;
		const phaseStartMs             = new Map<LatencyPhase, number>();
		const phaseDurations           = new Map<LatencyPhase, number>();
		const startPhase               = (name: LatencyPhase): void => {
			phaseStartMs.set(name, Date.now());
		};
		const endPhase                 = (name: LatencyPhase): void => {
			const started = phaseStartMs.get(name);
			if (!started) {
				return;
			}
			phaseDurations.set(name, (phaseDurations.get(name) || 0) + (Date.now() - started));
		};
		startPhase('prepare');
		const apiKey = await this.ensureApiKey();
		const openai = new OpenAI({apiKey});

		// Build database context
		const configs          = await databaseService.getConfigs();
		const dbConfigs        = configs.filter((c) => databaseIds.includes(c.id));
		const dbConfigById     = new Map(dbConfigs.map((c) => [c.id, c]));
		const allowedDbDisplay = dbConfigs.map((c) => `${c.name} (id: ${c.id})`).join(', ');

		let dbServerHost = '';
		if (dbHostOverride && String(dbHostOverride).trim() !== '') {
			dbServerHost = String(dbHostOverride).trim();
		} else if (databaseIds.length > 0) {
			const config = configs.find((c) => c.id === databaseIds[0]);
			if (config) dbServerHost = config.host;
		}

		// Check GitHub availability
		let githubConfig: { branch: string } | null = null;
		let hasGitHub: boolean;
		try {
			githubConfig = await githubService.getConfig();
			hasGitHub    = !!(githubConfig);
		} catch {
			hasGitHub = false;
		}

		const localRepoUrl                                        = githubService.getLocalRepoUrl();
		const queryResults: Array<{ query: string; data: any[] }> = [];
		const evidenceItems: AnswerEvidenceItem[]                 = [];
		const toolUsageStats                                      = {
			codeSearches    : 0,
			contextSearches : 0,
			fileReads       : 0,
			fileSectionReads: 0,
		};

		const ctx: ToolContext = {
			databaseService, githubService, schemaIndexService,
			spyCodeAiMcpService,
			databaseIds, databaseName, dbHostOverride, githubBranchOverride,
			onProgress, onDebugLog, queryResults, evidenceItems, toolUsageStats,
			dbConfigById, allowedDbDisplay,
			hasGitHub, localRepoUrl, githubConfig,
		};
		endPhase('prepare');

		onProgress?.('Preparing...');
		onDebugLog?.(
			'info',
			'OpenAI Quality',
			`Quality profile: ${effectiveQualityProfile}`,
			`iterations=${qualityConfig.agentMaxIterations}, maxTokens=${qualityConfig.maxTokens}, reasoningEffort=${qualityConfig.reasoningEffort}, reasoningSummary=${qualityConfig.reasoningSummary}`,
		);

		// Build system prompt
		startPhase('prompt_build');
		const serverDisplayName = dbServerHost.replace('.spysystem.dk', '');
		const dbIdContext       = dbConfigs.map((c) => `- ${c.name}: ${c.id}`).join('\n');

		const dbContextSection = contextBudget.includeDatabaseContext && databaseName && databaseIds.length > 0 ? `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SYSTEM CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are connected to the SPY System - a warehouse management and e-commerce platform built with PHP 8.1 backend and React 19 frontend.

CURRENT CONNECTION:
- Database: ${databaseName}
- Database IDs:
${dbIdContext || '- (none)'}
- Server: ${serverDisplayName} (${dbServerHost})

DATABASE QUERY WORKFLOW (MANDATORY):
1. search_schema first - find the correct table name
2. get_table_schema_cached - get the EXACT column names
3. query_database - write SQL using ONLY verified columns

NEVER guess table or column names. Always verify first.

Key facts about SPY database:
- "disabled" column (0=active, 1=disabled). No "is_active" column!
- Hungarian notation: iID (int), strName (string), bActive (bool), fPrice (float)
- No NULL values - use 0 for unset integers, empty string for text
- All tables have: added_user_id, added_date, changed_user_id, changed_date
- NEVER query from bi_* views - use actual tables
- Always use LIMIT for large tables
- Query results over 100 rows are automatically truncated
- "Active customers" = customers WHERE disabled = 0 AND type != 'b2c'

CSV EXPORT:
When the user asks for a "list", "export", "udtræk", "liste", "oversigt":
1. Use export_to_csv tool to create a CSV in the Downloads folder
2. Tell the user the exact filename and that it's in their Downloads folder` : '';

		const codeFirstDirective      = requiresCodeFirst
			? `

MANDATORY PAGE/MODULE INVESTIGATION:
- The user is asking about how a SPY page or module behaves.
- FIRST use search_code_context to find the controller/PHP file for that page or module.
- THEN find the actual query/filter logic the page uses.
- THEN query the database using the SAME logic as the page.
- Explain based on what the code really does, not your assumptions.`
			: '';
		const handlerDirective        = requiresHandlerNav
			? `

MANDATORY HANDLER/ACTION INVESTIGATION:
- The user is asking about an action, handler, modal, popup, or dialog.
- FIRST find the frontend action/controller with search_code_context.
- THEN trace which PHP controller/backend endpoint it calls.
- Explain the real flow from trigger to backend behavior.
- Translate internal handler names into user-facing UI guidance. Do NOT answer mainly with controller/action names unless the user explicitly asked for technical detail.`
			: '';
		const uiDirective             = (isUiQuestion || requiresHandlerNav || requiresCodeFirst)
			? `

MANDATORY UI GUIDANCE:
- The user wants help navigating or using the SPY UI.
- Answer in user-facing language using exact English SPY labels you verified in code.
- NEVER invent menu names, tabs, buttons, field labels, or navigation paths.
- NEVER lead with database tables, statuses, controller names, handler names, file paths, or raw code references for a simple UI question.
- For common workflow questions like creating a new order/customer/return, you MUST actively find the real entry point/menu path before answering.
- Do NOT stop at "I only confirmed the fields" if more UI searching can still find the actual navigation.
- Search for menu labels, navigation entries, and trigger points first; only mention uncertainty after you have tried multiple UI/code searches.
- For "how do I create X?" questions, prefer direct click steps in the UI over technical explanation.
- Behave as if you are mentally navigating the UI: identify the likely start page, then the relevant click/action on that page, then the destination page/dialog, then the next visible step.
- If you find config/admin/setup pages, do NOT assume they are the right answer for an operational workflow. Keep searching until you verify the real user workflow entry point.
- Treat chat memory as low priority for UI flows. Verified navigation evidence from code always wins.`
			: '';
		const toolsScriptDirective    = isToolsOrScriptQuestion
			? `

TOOLS/SCRIPT CODE-FIRST:
- This question mentions tools or scripts. Do NOT treat it as a normal UI-navigation question first.
- FIRST search the codebase with path-focused queries for the tools directories, especially path:tools and path:customer-scripts.
- Prefer script/tool implementation files over UI pages, forms, or settings screens unless the user explicitly asks how to navigate to them in the UI.
- If both a tool script and a UI page exist, explain the tool/script implementation first unless the user clearly asked for menu navigation.`
			: '';
		const databaseDirective       = requiresDatabase
			? `

MANDATORY DATABASE ACCESS:
- This question requires database access.
- You MUST use search_schema, get_table_schema_cached, and query_database before answering.
- Do NOT answer from memory when the database can verify it.
- Do NOT say you need more data if you can query it yourself.`
			: '';
		const integrationDirective    = requiresIntegrationFocus
			? `

MANDATORY INTEGRATION SETUP COVERAGE:
- This is an integration/setup question. Give the COMPLETE picture.
- Search the code for config UI, webhooks, API keys, linking logic, and prerequisites.
- Read multiple files when needed. Do NOT stop at the first match.
- For POS/Shopify-style flows, check whether consignment is required before answering.`
			: '';
		const hasSpyCodeAi            = await spyCodeAiMcpService.isConfigured();
		const spyCodeAiPrompt         = hasSpyCodeAi ? await loadPromptAsset(SPY_CODE_AI_PROMPT_ASSET) : '';
		if (spyCodeAiPrompt) {
			onDebugLog?.('info', 'System Prompt', 'Including spy-code-ai MCP guidance');
		}

		let systemPrompt = buildOpenAiCoreSystemPrompt({
			dbContextSection,
			codeFirstDirective,
			handlerDirective,
			uiDirective,
			databaseDirective,
			integrationDirective,
			toolsScriptDirective,
			spyCodeAiPrompt,
			includeDbWorkflow    : contextBudget.includeDatabaseContext,
			includeUiGuidance    : contextBudget.includeUiGrounding,
			includeCodeGrounding : contextBudget.includeCodeArchitecture,
		});
		endPhase('prompt_build');

		// Build messages
		const messages: OpenAiChatMessage[] = [];

		// Add conversation history
		if (conversationHistory && conversationHistory.length > 0) {
			const compactedHistory = compactConversationHistory(conversationHistory, contextBudget.historyMessages);
			onDebugLog?.(
				'info',
				'Context',
				`History compaction: ${conversationHistory.length} -> ${compactedHistory.length}`,
			);
			for (const msg of compactedHistory) {
				messages.push({role: msg.role as 'user' | 'assistant', content: msg.content});
			}
		}

		// Add user message with optional attachments
		let userText = userMessage;
		try {
			if (attachments && attachments.length > 0) {
				onProgress?.(`Processing ${attachments.length} attachment(s)...`);
				const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
				const processed                                                         = await Promise.all(attachments.map(async (att) => {
					if (att.mimeType && att.mimeType.startsWith('image/')) {
						const buf = await attachmentService.readAttachmentBuffer(att.storedPath);
						return {att, imageBase64: buf.toString('base64'), extracted: null as null | { text: string; truncated: boolean }};
					}
					const extracted = await attachmentService.extractTextForClaude(att.storedPath, att.mimeType, 40_000);
					return {att, imageBase64: null as string | null, extracted};
				}));
				for (const item of processed) {
					if (item.imageBase64 && item.att.mimeType) {
						contentParts.push({
							type     : 'image_url',
							image_url: {url: `data:${item.att.mimeType};base64,${item.imageBase64}`},
						});
						continue;
					}
					if (item.extracted && item.extracted.text.trim() !== '') {
						userText += `\n\nATTACHMENT: ${item.att.originalName} (${item.att.mimeType}, ${Math.round(item.att.sizeBytes / 1024)} KB)\n${item.extracted.text}${item.extracted.truncated ? '\n\n[Truncated]' : ''}`;
					}
				}

				if (contentParts.length > 0) {
					contentParts.unshift({type: 'text', text: userText});
					messages.push({role: 'user', content: contentParts});
				} else {
					messages.push({role: 'user', content: userText});
				}
			} else {
				messages.push({role: 'user', content: userMessage});
			}
		} catch (error) {
			onDebugLog?.('error', 'Attachments', 'Failed to process attachments', String(error));
			messages.push({role: 'user', content: userMessage});
		}

		startPhase('retrieval');
		let workingSummaryText = '';
		const retrievalTasks: Array<Promise<{
			kind: 'working_summary' | 'vector' | 'ui_grounding' | 'integration_grounding' | 'tools_grounding';
			payload: string | string[]
		}>>                    = [];
		if (contextBudget.includeWorkingSummary) {
			retrievalTasks.push((async () => {
				try {
					const chatRecord = await chatService.getChat(chatId);
					const ws         = (chatRecord as any)?.workingSummary?.text ? String((chatRecord as any).workingSummary.text) : '';
					return {kind: 'working_summary' as const, payload: ws};
				} catch {
					return {kind: 'working_summary' as const, payload: ''};
				}
			})());
		}
		retrievalTasks.push((async () => {
			try {
				const vectorStore = await this.ensureVectorStore();
				if (!vectorStore) {
					return {kind: 'vector' as const, payload: [] as string[]};
				}
				const searchQuery  = buildFollowUpRetrievalQuery(conversationHistory, userMessage, contextBudget.followUpHistoryMessages);
				const relevantDocs = await vectorStore.search(searchQuery, contextBudget.vectorDocuments);
				const vectorMeta   = vectorStore.getLastSearchMeta();
				onDebugLog?.('info', 'Vector Store', `Search ${vectorMeta?.cacheHit ? 'cache hit' : 'cache miss'} (${vectorMeta?.durationMs ?? 0} ms)`);
				return {kind: 'vector' as const, payload: relevantDocs.map((doc) => doc.text)};
			} catch {
				return {kind: 'vector' as const, payload: [] as string[]};
			}
		})());
		if (hasGitHub && contextBudget.includeToolsGrounding) {
			retrievalTasks.push((async () => {
				try {
					onProgress?.('Searching tools/scripts codebase...');
					const toolQueries = buildSharedToolsScriptQueries(userMessage);
					onDebugLog?.('info', 'Tools Grounding', `Queries: ${toolQueries.join(' | ')}`);
					const branch      = githubBranchOverride?.trim() || githubConfig?.branch || 'main';
					const toolBatches = await Promise.all(toolQueries.map(async (query) => {
						try {
							if (localRepoUrl) {
								return await githubService.searchCodeLocal(query, branch, localRepoUrl);
							}
							return await githubService.searchCode(query, githubBranchOverride);
						} catch {
							return [] as Array<{ path: string; matches: string[] }>;
						}
					}));
					return {kind: 'tools_grounding' as const, payload: formatOpenAiToolsCodeSearchResults(dedupeOpenAiCodeSearchResults(toolBatches.flat()))};
				} catch {
					return {kind: 'tools_grounding' as const, payload: ''};
				}
			})());
		}
		if (hasGitHub && contextBudget.includeUiGrounding) {
			retrievalTasks.push((async () => {
				try {
					onProgress?.('Searching UI codebase...');
					const uiQueries = buildSharedUiGroundingQueries(userMessage);
					onDebugLog?.('info', 'UI Grounding', `Queries: ${uiQueries.join(' | ')}`);
					const branch    = githubBranchOverride?.trim() || githubConfig?.branch || 'main';
					const uiBatches = await Promise.all(uiQueries.map(async (query) => {
						try {
							if (localRepoUrl) {
								return await githubService.searchCodeLocal(query, branch, localRepoUrl);
							}
							return await githubService.searchCode(query, githubBranchOverride);
						} catch {
							return [] as Array<{ path: string; matches: string[] }>;
						}
					}));
					const uiResults = await enrichOpenAiUiSearchResultsWithContext(
						dedupeOpenAiUiSearchResults(uiBatches.flat(), userMessage),
						{githubService, branch, localRepoUrl},
					);
					return {kind: 'ui_grounding' as const, payload: formatOpenAiUiCodeSearchResults(uiResults)};
				} catch {
					return {kind: 'ui_grounding' as const, payload: ''};
				}
			})());
		}
		if (hasGitHub && contextBudget.includeIntegrationGrounding) {
			retrievalTasks.push((async () => {
				try {
					const keywords          = extractSharedSearchKeywords(userMessage, 5);
					const integrationTerms  = ['setup', 'config', 'create', 'order', 'menu'];
					const query             = Array.from(new Set([...keywords, ...integrationTerms])).slice(0, 7).join(' ');
					const integrationResult = await githubService.searchCode(query, githubBranchOverride);
					return {kind: 'integration_grounding' as const, payload: formatOpenAiIntegrationCodeSearchResults(integrationResult)};
				} catch {
					return {kind: 'integration_grounding' as const, payload: ''};
				}
			})());
		}
		const retrievalResults = await Promise.all(retrievalTasks);
		for (const result of retrievalResults) {
			if (result.kind === 'working_summary') {
				const ws = String(result.payload || '');
				if (ws.trim() !== '') {
					workingSummaryText = ws.trim();
					onDebugLog?.('info', 'Working Summary', `Loaded existing summary (${ws.length} chars)`, ws.substring(0, 200) + (ws.length > 200 ? '...' : ''));
					systemPrompt += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKING SUMMARY (CHAT MEMORY — READ THIS FIRST)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${ws.trim()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NOTE: Table and column names in this summary are from PREVIOUS conversation turns.
- Use them as HINTS for where to look, but ALWAYS verify with search_schema or get_table_schema_cached before writing SQL.
- If a query fails with "table doesn't exist", the summary may be outdated — search for the correct name.
- If you find a contradiction between the summary and a tool result, ALWAYS trust the tool result.
- For UI workflow questions, IGNORE summary hints that point to a different workflow than the user's current task (for example new-customer admin setup vs existing-customer order creation).`;
				}
			}
			if (result.kind === 'vector') {
				const docs = result.payload as string[];
				if (docs.length > 0) {
					onDebugLog?.('info', 'Vector Store', `Found ${docs.length} relevant documents`);
					systemPrompt += '\n\nRELEVANT SYSTEM KNOWLEDGE:\n';
					docs.forEach((doc, i) => {
						systemPrompt += `\n${i + 1}. ${doc}`;
					});
				}
			}
			if (result.kind === 'ui_grounding') {
				const section = String(result.payload || '').trim();
				if (section) {
					onDebugLog?.('info', 'UI Grounding', 'Added UI grounding context', formatOpenAiGroundingDebugPreview(section));
					systemPrompt += `\n\n${section}`;
				}
			}
			if (result.kind === 'tools_grounding') {
				const section = String(result.payload || '').trim();
				if (section) {
					onDebugLog?.('info', 'Tools Grounding', 'Added tools/script grounding context', formatOpenAiGroundingDebugPreview(section));
					systemPrompt += `\n\n${section}`;
				}
			}
			if (result.kind === 'integration_grounding') {
				const section = String(result.payload || '').trim();
				if (section) {
					onDebugLog?.('info', 'Setup/How-to Grounding', 'Added setup grounding context', formatOpenAiGroundingDebugPreview(section));
					systemPrompt += `\n\n${section}`;
				}
			}
		}
		endPhase('retrieval');

		onProgress?.('Sending message to Jørgen...');
		onDebugLog?.('api', 'OpenAI API', `Sending message: "${userMessage.substring(0, 100)}${userMessage.length > 100 ? '...' : ''}"`);

		startPhase('technical');
		// Tool use loop
		let detailedAnswer                                                                                 = '';
		let clarificationRequest: { question: string; options?: string[]; allowFreeText?: boolean } | null = null;
		let iterations                                                                                     = 0;
		let agentLoopExhausted                                                                             = false;

		// We work with a mutable messages array for the loop
		const loopMessages: OpenAiChatMessage[] = [...messages];
		if (LATENCY_FLAGS.useTanStackOpenAI) {
			const tanstackResult = await this.runTanStackTechnicalPhase(
				messages,
				systemPrompt,
				apiKey,
				qualityConfig,
				ctx,
				onDebugLog,
				_onEvent,
				abortController,
			);
			detailedAnswer       = tanstackResult.detailedAnswer;
			clarificationRequest = tanstackResult.clarificationRequest;
			agentLoopExhausted   = tanstackResult.agentLoopExhausted;
		} else {
			const tools = await this.buildTools(ctx);
			while (iterations < qualityConfig.agentMaxIterations) {
				iterations++;

				if (abortController?.signal.aborted) {
					throw new Error('Request aborted');
				}

				onDebugLog?.('api', 'OpenAI API', `Agent loop iteration ${iterations}`);

				const response = await openai.chat.completions.create({
					model   : OPENAI_MODEL,
					messages: [
						{role: 'system', content: systemPrompt},
						...loopMessages,
					] as any,
					tools   : tools.length > 0 ? tools : undefined,
				});

				const choice = response.choices[0];
				if (!choice) break;

				const assistantMessage = choice.message;

				// Append assistant message to loop
				loopMessages.push({
					role      : 'assistant',
					content   : assistantMessage.content,
					tool_calls: assistantMessage.tool_calls,
				});

				// If no tool calls, we have the final answer
				if (choice.finish_reason === 'stop' || !assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
					detailedAnswer = assistantMessage.content || '';
					break;
				}

				// Execute tool calls
				onDebugLog?.('api', 'OpenAI API', `Executing ${assistantMessage.tool_calls.length} tool call(s)`);
				const toolCalls = assistantMessage.tool_calls.map((toolCall) => {
					const tc       = toolCall as any;
					const toolName = tc.function?.name || '';
					let toolArgs: any;
					try {
						toolArgs = JSON.parse(tc.function?.arguments || '{}');
					} catch {
						toolArgs = {};
					}
					return {tc, toolName, toolArgs};
				});

				const clarifyingTool = toolCalls.find((t) => t.toolName === 'ask_clarifying_question');
				if (clarifyingTool) {
					clarificationRequest = {
						question     : clarifyingTool.toolArgs.question || '',
						options      : clarifyingTool.toolArgs.options,
						allowFreeText: clarifyingTool.toolArgs.allowFreeText !== false,
					};
					onDebugLog?.('info', 'Clarification', 'AI requested clarification');
					loopMessages.push({
						role        : 'tool',
						tool_call_id: String(clarifyingTool.tc.id || ''),
						content     : JSON.stringify({acknowledged: true}),
					});
					break;
				}

				const toolMessages: Array<{ index: number; message: OpenAiChatMessage }> = [];
				const executeOne                                                         = async (tool: {
					tc: any;
					toolName: string;
					toolArgs: any
				}, index: number): Promise<void> => {
					const {tc, toolName, toolArgs} = tool;

					onProgress?.(`Running tool: ${toolName}`);
					onDebugLog?.('tool', 'Tool Call', `Starting: ${toolName}`);
					let toolResult: any;
					try {
						toolResult = await this.executeTool(toolName, toolArgs, ctx);
					} catch (error) {
						toolResult = {error: `Tool execution failed: ${String(error)}`};
						onDebugLog?.('error', 'Tool Call', `Failed: ${toolName}`, String(error));
					}

					onDebugLog?.('tool', 'Tool Call', `Completed: ${toolName}`, JSON.stringify(toolResult).substring(0, 200));

					toolMessages.push({
						index,
						message: {
							role        : 'tool',
							tool_call_id: String(tc.id || ''),
							content     : JSON.stringify(toolResult),
						},
					});
				};
				if (LATENCY_FLAGS.enableParallelToolCalls && toolCalls.length > 1) {
					await runWithConcurrency(toolCalls, MAX_PARALLEL_TOOL_CALLS, executeOne);
				} else {
					for (let i = 0; i < toolCalls.length; i++) {
						await executeOne(toolCalls[i], i);
					}
				}
				for (const item of toolMessages.sort((a, b) => a.index - b.index)) {
					loopMessages.push(item.message);
				}
			}
			if (iterations >= qualityConfig.agentMaxIterations && !clarificationRequest && !detailedAnswer) {
				agentLoopExhausted = true;
			}
		}
		endPhase('technical');

		// Return clarification request if needed
		if (clarificationRequest) {
			return {
				needsClarification: true,
				question          : clarificationRequest.question,
				options           : clarificationRequest.options,
				allowFreeText     : clarificationRequest.allowFreeText !== false,
			};
		}

		// Fallback: detect if AI wrote clarifying options as plain text instead of using the tool
		const textClarification = detectTextClarification(detailedAnswer);
		if (textClarification) {
			return {
				needsClarification: true,
				question          : textClarification.question,
				options           : textClarification.options,
				allowFreeText     : true,
			};
		}

		detailedAnswer = sanitizeAssistantAnswer(detailedAnswer.trim());
		onDebugLog?.('api', 'OpenAI API', `Technical phase complete, answer length: ${detailedAnswer.length}`);
		let evidenceSummary = formatAnswerEvidenceSummary(evidenceItems);
		onDebugLog?.('info', 'Answer Evidence', `Captured ${evidenceItems.length} evidence item(s)`, evidenceSummary);

		const requiredDatabaseButNoQueries = requiresDatabase && queryResults.length === 0 && !requiresIntegrationFocus;
		const midInvestigation             = looksLikeMidInvestigation(detailedAnswer);
		const uiAnswerNeedsRetry           = isUiQuestion
			&& !hasConcreteIdentifier
			&& needsVerifiedUiRetry(detailedAnswer, toolUsageStats);
		onDebugLog?.(
			'info',
			'OpenAI Quality',
			`Tool usage: code=${toolUsageStats.codeSearches}, context=${toolUsageStats.contextSearches}, file=${toolUsageStats.fileReads}, section=${toolUsageStats.fileSectionReads}`,
			uiAnswerNeedsRetry ? 'UI answer flagged for insufficient grounding' : undefined,
		);
		const midInvestigationNeedsRetry = midInvestigation && queryResults.length === 0;
		const {qualityCheck, shouldRetryTechnical} = decideOpenAiTechnicalRetry({
			detailedAnswer,
			evidenceItems,
			requiredDatabaseButNoQueries,
			uiAnswerNeedsRetry,
			midInvestigationNeedsRetry,
			nonAnswer: isNonAnswer(detailedAnswer),
			useTanStackOpenAI: LATENCY_FLAGS.useTanStackOpenAI,
		});
		if (shouldRetryTechnical) {
			onProgress?.('Finishing analysis...');
			onDebugLog?.(
				'info',
				'OpenAI Retry',
				`Retrying technical phase: ${qualityCheck.reasons.join('; ')}`,
			);
			const queryResultsSummary                = queryResults.length > 0
				? `\n\nYou already executed these queries and got results:\n${queryResults.slice(0, 5).map((qr, i) => `${i + 1}. Query: ${qr.query.substring(0, 120)}\n   Result: ${qr.data.length} rows`).join('\n')}\n\nUSE THIS DATA in your final answer.`
				: '';
			const forceToolUseDirective              = requiredDatabaseButNoQueries
				? `

CRITICAL ERROR: You did NOT use database tools, but this question REQUIRES database access.
You MUST:
1. Use search_schema to find the relevant table(s)
2. Use get_table_schema_cached to verify columns
3. Use query_database to get the real data
4. Then answer with the actual findings`
				: '';
			const forceUiGroundingDirective          = uiAnswerNeedsRetry
				? `

CRITICAL ERROR: Your previous UI answer was not grounded enough.
You MUST:
1. Use search_code_context to find the actual UI entry page, action, or navigation trigger.
2. Use read_file or read_file_section on the best matching files.
3. Verify the real click path from code before answering.
4. Do NOT answer with "normally", "typically", guessed flows, or "if you want I can find the path".
5. If exact navigation still cannot be verified from code, say that clearly instead of inventing a path.`
				: '';
			const retryMessages: OpenAiChatMessage[] = [
				...messages,
				...(detailedAnswer ? [{role: 'assistant' as const, content: detailedAnswer}] : []),
				{
					role   : 'user' as const,
					content: buildOpenAiRetryPrompt({
						forceToolUseDirective,
						forceUiGroundingDirective,
						queryResultsSummary,
						evidenceSummary,
						requiredDatabaseButNoQueries,
					}),
				},
			];
			try {
				const retryResult = await this.runTanStackTechnicalPhase(
					retryMessages,
					systemPrompt,
					apiKey,
					qualityConfig,
					ctx,
					onDebugLog,
					_onEvent,
					abortController,
				);
				if (retryResult.clarificationRequest) {
					return {
						needsClarification: true,
						question          : retryResult.clarificationRequest.question,
						options           : retryResult.clarificationRequest.options,
						allowFreeText     : retryResult.clarificationRequest.allowFreeText !== false,
					};
				}
				const retried      = sanitizeAssistantAnswer(retryResult.detailedAnswer || '');
				agentLoopExhausted = agentLoopExhausted || retryResult.agentLoopExhausted;
				if (retried && (retried.length >= 150 || detailedAnswer.length < 500)) {
					detailedAnswer = retried;
					evidenceSummary = formatAnswerEvidenceSummary(evidenceItems);
				}
			} catch (error) {
				onDebugLog?.('error', 'OpenAI Retry', 'Technical retry failed', String(error));
			}
		}

		const {completionQualityCheck, needsCompletionPass} = decideOpenAiCompletionPass({
			detailedAnswer,
			evidenceItems,
			agentLoopExhausted,
			looksLikeMidInvestigation: looksLikeMidInvestigation(detailedAnswer),
		});
		if (needsCompletionPass) {
			onProgress?.('Finalizing answer...');
			onDebugLog?.(
				'info',
				'OpenAI Completion',
				`Running completion pass (exhausted=${agentLoopExhausted}, midInvestigation=${looksLikeMidInvestigation(detailedAnswer)}, reasons=${completionQualityCheck.reasons.join('; ') || 'standard completion'}, evidence=${evidenceItems.length})`,
			);
			try {
				const queryDataSummary   = queryResults.map((qr, i) => {
					const preview = qr.data.length > 10
						? `${JSON.stringify(qr.data.slice(0, 10))}\n... (${qr.data.length} rows total)`
						: JSON.stringify(qr.data);
					return `Query ${i + 1}: ${qr.query}\nRows: ${qr.data.length}\nData: ${preview}`;
				}).join('\n\n');
				const completionPrompt   = buildOpenAiCompletionPrompt({
					userMessage,
					detailedAnswer,
					queryDataSummary,
					queryCount: queryResults.length,
					evidenceSummary,
				});
				const completionResponse = await openai.chat.completions.create({
					model                : OPENAI_MODEL,
					messages             : [
						{role: 'system', content: systemPrompt},
						...messages,
						...(detailedAnswer ? [{role: 'assistant' as const, content: detailedAnswer}] : []),
						{role: 'user' as const, content: completionPrompt},
					] as any,
					max_completion_tokens: qualityConfig.completionMaxTokens,
				});
				const completed          = sanitizeAssistantAnswer(completionResponse.choices[0]?.message?.content?.trim() || '');
				if (completed && completed.length > 50) {
					detailedAnswer = completed;
				}
			} catch (error) {
				onDebugLog?.('error', 'OpenAI Completion', 'Completion pass failed', String(error));
			}
		}

		// Auto-export CSV if user requested it
		const exportKeywords  = ['list', 'liste', 'udtræk', 'export', 'eksporter', 'overview', 'oversigt'];
		const isExportRequest = exportKeywords.some((keyword) => userMessage.toLowerCase().includes(keyword));
		if (isExportRequest && queryResults.length > 0) {
			const largestResult = queryResults.reduce((prev, current) =>
				current.data.length > prev.data.length ? current : prev,
			);
			if (largestResult.data.length >= 10) {
				onProgress?.(`Auto-generating CSV with ${largestResult.data.length} rows...`);
				try {
					const now      = new Date();
					const dateStr  = now.toISOString().split('T')[0];
					const timeStr  = now.toTimeString().split(' ')[0].replace(/:/g, '-');
					const filename = `export_${dateStr}_${timeStr}.csv`;
					await exportToCsvFile(filename, largestResult.data);
					detailedAnswer += `\n\nEn CSV-fil er automatisk oprettet: **${filename}** med ${largestResult.data.length} rækker gemt i Downloads-mappen.`;
				} catch {
					// Non-fatal
				}
			}
		}

		// If no answer was produced, ask explicitly
		if (!detailedAnswer && queryResults.length > 0) {
			onProgress?.('Generating final answer...');
			const queryDataSummary = queryResults.map((qr, i) => `Query ${i + 1}: ${qr.query}\nRows: ${qr.data.length}\nData: ${JSON.stringify(qr.data.slice(0, 5))}`).join('\n\n');

			loopMessages.push({
				role   : 'user',
				content: `Provide a complete answer in the SAME LANGUAGE as the original question based on the database results above. Data found:\n${queryDataSummary}\n\nDo NOT narrate your process. Give the direct answer.`,
			});

			const fallbackResponse = await openai.chat.completions.create({
				model   : OPENAI_MODEL,
				messages: [
					{role: 'system', content: systemPrompt},
					...loopMessages,
				] as any,
			});
			detailedAnswer         = sanitizeAssistantAnswer(fallbackResponse.choices[0]?.message?.content?.trim() || '');
		}

		if (looksTruncatedAnswer(detailedAnswer)) {
			onDebugLog?.('info', 'OpenAI API', 'Technical answer looks truncated; requesting continuation');
			try {
				const continuationResponse = await openai.chat.completions.create({
					model   : OPENAI_MODEL,
					messages: [
						{role: 'system', content: systemPrompt},
						...messages,
						{role: 'assistant', content: detailedAnswer},
						{
							role   : 'user',
							content: `Continue the answer exactly where it stopped.

Rules:
- Answer in the SAME LANGUAGE as the original question.
- Do NOT repeat earlier content.
- Output ONLY the missing continuation text.
- If the answer is already complete, reply exactly: COMPLETE`,
						},
					] as any,
				});
				const continuationText     = sanitizeAssistantAnswer(continuationResponse.choices[0]?.message?.content?.trim() || '');
				if (continuationText && !looksLikeNonContinuation(continuationText)) {
					detailedAnswer = sanitizeAssistantAnswer(`${detailedAnswer}\n${continuationText}`);
				}
			} catch (error) {
				onDebugLog?.('error', 'OpenAI API', 'Technical continuation failed', String(error));
			}
		}

		// Simplification stage
		startPhase('postprocess');
		onProgress?.('Simplifying answer...');

		const detailedLinesCount        = detailedAnswer ? detailedAnswer.split('\n').filter((line) => line.trim() !== '').length : 0;
		const headerCount               = (detailedAnswer.match(/^#{1,4}\s/gm) || []).length;
		const isAlreadyShort            = detailedLinesCount > 0 && detailedLinesCount <= 4 && detailedAnswer.length <= 700;
		const isAlreadyCompleteGuide    = detailedAnswer.length >= 1200 && headerCount >= 2 && detailedLinesCount >= 15;
		let shortAnswer                 = detailedAnswer;
		const shouldKeepDetailedAsShort = isAlreadyCompleteGuide && desiredDetailLevel === 'detailed';
		const shouldSkipSimplification  = shouldKeepDetailedAsShort
			|| (effectiveQualityProfile === 'maximum_accuracy' && detailedAnswer.length <= 1800 && !looksLikeMidInvestigation(detailedAnswer));

		if (!shouldSkipSimplification && (!isAlreadyShort || desiredDetailLevel !== 'short')) {
			const simplificationPrompt = buildOpenAiSimplificationPrompt({
				userMessage,
				detailedAnswer,
				desiredDetailLevel,
				evidenceSummary,
			});
			try {
				const simplificationResponse = await openai.chat.completions.create({
					model                : OPENAI_MODEL,
					messages             : [
						{role: 'user', content: simplificationPrompt},
					],
					max_completion_tokens: qualityConfig.simplificationMaxTokens,
				});

				shortAnswer = sanitizeAssistantAnswer(simplificationResponse.choices[0]?.message?.content?.trim() || detailedAnswer);
				onDebugLog?.('api', 'OpenAI API', `Simplification complete, short answer length: ${shortAnswer.length}`);
			} catch (error) {
				onDebugLog?.('error', 'OpenAI API', 'Simplification failed', String(error));
			}
		} else if (shouldSkipSimplification) {
			onDebugLog?.('info', 'OpenAI API', `Skipped simplification (qualityProfile=${effectiveQualityProfile})`);
		}
		// Generate chat title
		let suggestedTitle: string | undefined;
		const summaryTask = async (): Promise<void> => {
			try {
				const detailedExcerpt    = detailedAnswer && detailedAnswer.length > 5000
					? detailedAnswer.substring(0, 5000) + '\n[...truncated...]'
					: (detailedAnswer || shortAnswer);
				const recentConversation = formatRecentConversationForSummary(conversationHistory, 6) || '(none)';
				const updatePrompt       = `You are maintaining a detailed working summary for an ongoing SPY support chat.

Update the existing summary using the latest exchange below.

REQUIRED SECTIONS (use these exact headers):

## Confirmed Facts
- Key findings, concrete answers, confirmed business rules, and important numbers established so far

## Latest Answer
- Preserve the most recent concrete conclusion, distinction, or recommendation the assistant gave
- Make short follow-up references like "that", "same", "other one", and "instead" understandable from this section

## Database Context
- Tables used, key columns, successful query patterns, joins, and filters
- Include failed schema assumptions too when useful

## Active Thread
- What the user is investigating right now
- What branch, comparison, workflow, record, or module is currently in focus
- What still needs answering next

## Code Context
- Relevant files, classes, functions, handlers, or modules identified so far
- Summarize the confirmed code flow when code was investigated

## Open Questions
- Remaining uncertainties, follow-up items, or hypotheses still to verify

RULES:
- Output plain text only
- Keep table and column names EXACT
- Remove outdated points
- Preserve identifiers, query patterns, filenames, and exact symbols when relevant
- Be detailed but compact. Aim for up to 32 bullets total across all sections
- Prefer durable investigative context over polished prose
- This summary is for the AI assistant, so keep technical context if it helps future turns

Existing summary:
${workingSummaryText || '(none)'}

Recent conversation:
${recentConversation}

Latest user message:
${userMessage}

Assistant technical answer:
${detailedExcerpt}`;
				let summaryText          = '';
				try {
					const summaryResponse = await openai.chat.completions.create({
						model                : 'gpt-4o-mini',
						messages             : [{role: 'user', content: updatePrompt}],
						max_completion_tokens: 1800,
					});
					summaryText           = summaryResponse.choices[0]?.message?.content?.trim() || '';
				} catch (miniError) {
					onDebugLog?.('error', 'Working Summary', `gpt-4o-mini failed: ${miniError instanceof Error ? miniError.message : String(miniError)}`);
				}
				if (!summaryText) {
					const fallbackResponse = await openai.chat.completions.create({
						model                : OPENAI_MODEL,
						messages             : [{role: 'user', content: updatePrompt}],
						max_completion_tokens: 1800,
					});
					summaryText            = fallbackResponse.choices[0]?.message?.content?.trim() || '';
				}
				if (summaryText.trim()) {
					await chatService.setWorkingSummary(chatId, summaryText.trim());
				}
			} catch (error) {
				onDebugLog?.('error', 'Working Summary', 'Failed to update working summary', String(error));
			}
		};
		try {
			const chatRecord           = await chatService.getChat(chatId);
			const systemName           = (chatRecord?.systemName || '').trim();
			const databaseNameForTitle = (chatRecord?.databaseName || '').trim();
			const context              = systemName || databaseNameForTitle
				? `Context:\n- System: ${systemName || '(none)'}\n- Database: ${databaseNameForTitle || '(none)'}\n`
				: '';

			const titlePrompt = `Create a short chat title in Danish.\n\nCRITICAL RULES:\n- Output ONLY the title text (no quotes, no prefix, no markdown)\n- 3 to 6 words\n- Must describe the topic (what this chat is about)\n- Avoid filler and function words (no "jeg", "mig", "hjælp", "kan", "vil", "skal", "blevet", "dannet")\n- Prefer concrete nouns + identifiers (return/order numbers, module name, integration name)\n- Use the exact English SPY UI labels if you mention menus/modules/buttons\n\nGood examples:\n- Return 11150 – Shopify webhook\n- NemEDI opsætning og fejlsøgning\n- Claims/Return: Spor oprettelse\n\n${context}\nLatest user message:\n${userMessage}\n\nAssistant answer:\n${shortAnswer}`;

			// Use cheap model for title, fall back to main model if it fails
			let raw = '';
			try {
				const titleResponse = await openai.chat.completions.create({
					model                : 'gpt-4o-mini',
					messages             : [{role: 'user', content: titlePrompt}],
					max_completion_tokens: 100,
				});
				raw                 = titleResponse.choices[0]?.message?.content?.trim() || '';
				onDebugLog?.('info', 'Chat Title', `gpt-4o-mini generated: "${raw}"`);
			} catch (miniError) {
				onDebugLog?.('error', 'Chat Title', `gpt-4o-mini failed: ${miniError instanceof Error ? miniError.message : String(miniError)}`);
			}

			if (!raw) {
				onDebugLog?.('info', 'Chat Title', `Retrying with ${OPENAI_MODEL}...`);
				try {
					const fallbackResponse = await openai.chat.completions.create({
						model                : OPENAI_MODEL,
						messages             : [{role: 'user', content: titlePrompt}],
						max_completion_tokens: 100,
					});
					raw                    = fallbackResponse.choices[0]?.message?.content?.trim() || '';
				} catch (fallbackError) {
					onDebugLog?.('error', 'Chat Title', `Fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
				}
			}

			const candidate = normalizeTitleCandidate(raw);
			if (isValidTitleCandidate(candidate)) {
				suggestedTitle = candidate.length > 60 ? `${candidate.substring(0, 57)}...` : candidate;
				onDebugLog?.('info', 'Chat Title', `Title accepted: "${suggestedTitle}"`);
			} else {
				const fallback = generateFallbackTitle({userMessage, assistantAnswer: shortAnswer, systemName});
				if (fallback) {
					onDebugLog?.('info', 'Chat Title', `AI title rejected; using fallback: "${fallback}"`, `raw="${raw}"`);
					suggestedTitle = fallback;
				} else {
					onDebugLog?.('info', 'Chat Title', 'AI title rejected; no fallback available', `raw="${raw}"`);
				}
			}
		} catch (error) {
			onDebugLog?.('error', 'Chat Title', 'Failed to generate title', String(error));
		}
		await summaryTask();
		endPhase('postprocess');
		phaseDurations.set('total', Date.now() - requestStartMs);
		if (LATENCY_FLAGS.enableLatencyMetrics) {
			const metrics = {
				provider   : 'openai',
				totalMs    : phaseDurations.get('total') || 0,
				prepareMs  : phaseDurations.get('prepare') || 0,
				promptMs   : phaseDurations.get('prompt_build') || 0,
				retrievalMs: phaseDurations.get('retrieval') || 0,
				technicalMs: phaseDurations.get('technical') || 0,
				postMs     : phaseDurations.get('postprocess') || 0,
			};
			onDebugLog?.('info', 'Latency', `OpenAI latency metrics`, JSON.stringify(metrics));
		}

		return {shortAnswer, detailedAnswer, suggestedTitle};
	}
}

function sanitizeTitleText(title: string): string {
	return (title || '')
		.replace(/[|/\\]+/g, ' ')
		.replace(/\s*[-–—]\s*/g, ' – ')
		.replace(/\s+/g, ' ')
		.replace(/[.!,;:]+$/g, '')
		.trim();
}

function normalizeTitleCandidate(raw: string): string {
	const clean = (raw || '')
		.replace(/^\s*(titel|title)\s*:\s*/i, '')
		.replace(/^\s*[-–—]\s*/i, '')
		.replace(/^["'`]+|["'`]+$/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return sanitizeTitleText(clean);
}

function isValidTitleCandidate(title: string): boolean {
	const trimmed = (title || '').trim();
	if (trimmed.length < 3) return false;
	const words = (trimmed.match(/[A-Za-zÆØÅæøå0-9]+/g) || []);
	if (words.length < 3 || words.length > 6) return false;
	const forbidden = /\b(jeg|mig|min|hjælp\w*|kan|vil|skal|lad|find\w*|søge\w*|kig\w*|undersøg\w*|blev\w*|dannet)\b/i;
	if (forbidden.test(trimmed)) return false;
	const shortWords = words.filter((w) => w.length <= 3).length;
	return !(words.length >= 4 && shortWords >= Math.ceil(words.length * 0.6));
}

function generateFallbackTitle(input: { userMessage: string; assistantAnswer: string; systemName: string }): string {
	const user   = input.userMessage || '';
	const answer = input.assistantAnswer || '';

	const returnNoMatch = user.match(/\b(?:return|retur|rma)\s*(?:no\.|nr\.|#)?\s*(\d{3,})\b/i);
	const orderMatch    = user.match(/\b(?:ordre|order)\s*(?:no\.|nr\.|#)?\s*(\d{3,})\b/i);
	const hasShopify    = /\bshopify\b/i.test(user) || /\bshopify\b/i.test(answer);
	const hasNemEdi     = /\bnemedi\b/i.test(user) || /\bnemedi\b/i.test(answer);

	if (hasNemEdi) return 'NemEDI opsætning og fejlsøgning';

	const parts: string[] = [];
	if (returnNoMatch?.[1]) {
		parts.push(`Return ${returnNoMatch[1]}`);
	} else if (orderMatch?.[1]) {
		parts.push(`Order ${orderMatch[1]}`);
	}
	if (hasShopify) parts.push('Shopify webhook');

	if (parts.length === 0) {
		const tokens  = (user.match(/[A-Za-zÆØÅæøå0-9]+/g) || []).filter((t) => t.length >= 4 || /^\d+$/.test(t));
		const cleaned = sanitizeTitleText(tokens.slice(0, 6).join(' '));
		return cleaned.length >= 3 ? cleaned.substring(0, 60).trim() : '';
	}

	let title = sanitizeTitleText(parts.join(' – '));
	const wds = (title.match(/[A-Za-zÆØÅæøå0-9]+/g) || []);
	if (wds.length > 6) title = wds.slice(0, 6).join(' ');
	return title.substring(0, 60).trim();
}

function normalizeOpenAiQualityProfile(profile?: AiQualityProfile): AiQualityProfile {
	return profile === 'balanced' ? 'balanced' : 'maximum_accuracy';
}

function getOpenAiQualityConfig(profile: AiQualityProfile): OpenAiQualityConfig {
	if (profile === 'balanced') {
		return {
			agentMaxIterations     : 30,
			maxTokens              : 16_000,
			completionMaxTokens    : 5000,
			simplificationMaxTokens: 2600,
			reasoningEffort        : 'low',
			reasoningSummary       : 'concise',
		};
	}

	return {
		agentMaxIterations     : 50,
		maxTokens              : 24_000,
		completionMaxTokens    : 8000,
		simplificationMaxTokens: 3200,
		reasoningEffort        : 'medium',
		reasoningSummary       : 'detailed',
	};
}

function sanitizeAssistantAnswer(text: string): string {
	let out = (text || '').trim();
	if (!out) {
		return '';
	}
	out = out.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
	out = out.replace(/^\s*(thinking|reasoning|analysis)\s*:\s*.*$/gmi, '');
	out = out.replace(/^\s*\[thinking\].*$/gmi, '');

	const processPatterns: RegExp[] = [
		/^\s*jeg\s+(?:vil\s+)?(?:først\s+)?(?:undersøg\w*|tjek\w*|kig\w*|find\w*|søge\w*)[^.?!]*[.?!]\s*/i,
		/^\s*lad\s+mig[^.?!]*[.?!]\s*/i,
		/^\s*nu\s+kan\s+jeg\s+se[^.?!]*[.?!]\s*/i,
		/\bnu\s+har\s+jeg\s+fundet\b[^.!?:]*[.!?:]\s*/gi,
		/\bjeg\s+har\s+fundet\b[^.!?]*[.!?]\s*/gi,
	];
	for (const re of processPatterns) {
		out = out.replace(re, '');
	}
	out = out.replace(/[ \t]+/g, ' ');
	out = out.replace(/\n{3,}/g, '\n\n');
	return out.trim();
}

function isNonAnswer(text: string): boolean {
	const t = String(text || '').trim();
	if (!t) {
		return true;
	}
	const cannotAnswerPatterns = [
		/\bjeg\s+kan\s+ikke\s+give\s+dig\s+(?:et\s+)?(?:konkret|præcist|specifikt)?\s*svar\b/i,
		/\bjeg\s+kan\s+ikke\s+(?:svare|besvare)\s+(?:dette|dit|uden)\b/i,
		/\bfor\s+at\s+(?:hjælpe|besvare|svare)\s+dig\s+(?:skal|har)\s+jeg\s+brug\s+for\b/i,
		/\bi\s+cannot\s+(?:give|provide)\s+(?:you\s+)?(?:a\s+)?(?:concrete|specific|precise)?\s*answer\b/i,
		/\bi\s+need\s+(?:more\s+)?information\s+(?:to|before)\b/i,
	];
	for (const re of cannotAnswerPatterns) {
		if (re.test(t)) {
			return true;
		}
	}
	if (t.length < 260 && /\b(jeg\s+undersøg\w*|jeg\s+skal\s+undersøg\w*|jeg\s+vil\s+undersøg\w*|lad\s+mig|i'?ll\s+search|i\s+will\s+search)\b/i.test(t)) {
		return true;
	}
	const hasDigit    = /\d/.test(t);
	const hasPathLike = /[A-Za-z0-9_-]+\.(php|ts|tsx|js|jsx)\b/i.test(t) || /[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\b/.test(t);
	return !hasDigit && !hasPathLike && t.length < 350;
}

function needsVerifiedUiRetry(
	answer: string,
	toolUsageStats: { codeSearches: number; contextSearches: number; fileReads: number; fileSectionReads: number },
): boolean {
	const strongUiInvestigation = (
		toolUsageStats.contextSearches >= 1
		&& (toolUsageStats.contextSearches + toolUsageStats.fileReads + toolUsageStats.fileSectionReads) >= 2
	) || (
		toolUsageStats.codeSearches >= 2
		&& toolUsageStats.contextSearches >= 1
	);
	return !strongUiInvestigation || looksLikeUngroundedUiAnswer(answer);
}

function looksLikeUngroundedUiAnswer(text: string): boolean {
	const t = String(text || '').trim();
	if (!t) {
		return true;
	}
	const offerToInvestigateLater = [
		/\bhvis\s+du\s+vil\b.{0,80}\bkan\s+jeg\b.{0,120}\b(finde|vise|beskrive)\b/i,
		/\bif\s+you\s+want\b.{0,80}\bi\s+can\b.{0,120}\b(find|show|describe)\b/i,
	];
	if (offerToInvestigateLater.some((re) => re.test(t))) {
		return true;
	}
	if (/\b(normalt|typisk|usually|normally|som\s+udgangspunkt)\b/i.test(t) && /\b(gå\s+til|go\s+to|start(?:er)?\s+fra|start\s+from|åbn|open)\b/i.test(t)) {
		return true;
	}
	return /\b(der\s+findes\s+også\s+en\s+side|jeg\s+kan\s+også\s+se\s+et\s+flow|there\s+is\s+also\s+a\s+page|i\s+can\s+also\s+see\s+a\s+flow)\b/i.test(t);
}

function looksLikeMidInvestigation(text: string): boolean {
	const t = String(text || '').trim();
	if (!t || t.length < 100) {
		return false;
	}
	const tail     = t.slice(-300);
	const patterns = [
		/(?:nu\s+(?:skal|kan|vil|tjekker|checker|sammenligner|kigger)\s+jeg)\b/i,
		/(?:lad\s+mig\s+(?:prøve|tjekke|checke|undersøge|kigge|finde|query|hente|sammenligne))/i,
		/(?:jeg\s+(?:vil|skal|kan)\s+nu\s+(?:tjekke|checke|undersøge|sammenligne|query))/i,
		/(?:let\s+me\s+(?:check|try|query|look|search|compare|find|get))/i,
		/(?:now\s+(?:i\s+(?:can|will|need\s+to)|let's|checking|querying|comparing))/i,
	];
	for (const re of patterns) {
		if (re.test(tail)) {
			return true;
		}
	}
	return !/sammenfattende|opsummering|konklusion|resultat(?:et)?|svaret?\s+er|total(?:t|en)?|i\s+alt|conclusion|summary|result|in\s+total|the\s+answer/i.test(tail)
		&& t.length > 1500
		&& looksTruncatedAnswer(t);
}

function looksTruncatedAnswer(text: string): boolean {
	const t = String(text || '').trim();
	if (!t) {
		return false;
	}
	if (/(,\s*[A-Za-zÆØÅæøå]{1,3}\s*)$/.test(t) || /:\s*$/.test(t) || /\(\s*$/.test(t)) {
		return true;
	}
	if (!/[.?!…]$/.test(t) && t.length > 600) {
		return true;
	}
	return /[A-Za-zÆØÅæøå]\s*$/.test(t) && !/[.?!…]$/.test(t);
}

function looksLikeNonContinuation(text: string): boolean {
	const t = String(text || '').trim().toLowerCase();
	if (!t || t === 'complete') {
		return true;
	}
	const patterns = [
		/\bthe answer is already complete\b/i,
		/\bno continuation (?:is )?needed\b/i,
		/\bnothing (?:more )?to (?:add|continue)\b/i,
		/\bsvaret er (?:allerede )?(?:komplet|færdig|fuldendt)\b/i,
		/\bingen fortsættelse\b/i,
	];
	return patterns.some((re) => re.test(t));
}
