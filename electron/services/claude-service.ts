import Anthropic from '@anthropic-ai/sdk';
import {app} from 'electron';
import * as fs from 'fs/promises';
import path from 'path';
import type {DatabaseService} from './database-service';
import type {GitHubService} from './github-service';
import {SecureStorageService} from './secure-storage-service';
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
		userMessage: string,
		databaseIds: string[],
		databaseService: DatabaseService,
		githubService: GitHubService,
		onProgress?: (status: string) => void,
		conversationHistory?: Array<{ role: string; content: string }>,
		databaseName?: string,
		onDebugLog?: (type: 'query' | 'tool' | 'api' | 'error' | 'info', category: string, message: string, details?: string) => void,
	): Promise<string> {
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
						description : `Execute a READ-ONLY SQL query on database: ${dbDisplayName}. ONLY SELECT, SHOW, DESCRIBE, and EXPLAIN queries are allowed. Write operations (INSERT, UPDATE, DELETE, etc.) are NEVER permitted.`,
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
				description : `Search for code in the ${githubConfig.owner}/${githubConfig.repo} repository`,
				input_schema: {
					type      : 'object',
					properties: {
						query: {
							type       : 'string',
							description: 'Search query (e.g., "function calculatePrice", "class Customer")',
						},
					},
					required  : ['query'],
				},
			});

			tools.push({
				name        : 'read_file',
				description : `Read the contents of a file from the ${githubConfig.owner}/${githubConfig.repo} repository`,
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

		// Add the new user message
		messages.push({
			role   : 'user',
			content: userMessage,
		});

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


		// Build system prompt
		let systemPrompt = `You are a helpful assistant that answers questions accurately and clearly. ALWAYS respond in the same language as the user's question.

THINKING PROCESS:
Before using any tools, use <thinking> tags to plan your approach:
- What information do I need to answer this question?
- Do I need to query the database, or can I answer from existing knowledge?
- Do I need to look at code files, or is this a data question?
- What's the most efficient way to get the answer?

Use your thinking to avoid unnecessary work - don't query the database if you can answer from context, and don't search code if you just need data.`;

		// Add relevant context from vector store
		if (contextDocuments.length > 0) {
			systemPrompt += '\n\nRELEVANT SYSTEM KNOWLEDGE:\n';
			contextDocuments.forEach((doc, index) => {
				systemPrompt += `\n${index + 1}. ${doc}`;
			});
			systemPrompt += '\n\nUse this knowledge to help answer the user\'s question when relevant.';
			onDebugLog?.('info', 'Vector Store', `Added ${contextDocuments.length} documents to system prompt`);
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

3. Always check table structure with describe_table before querying
4. Use LIMIT when querying large tables to avoid timeouts
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

ALWAYS provide step-by-step UI instructions with specific button names and menu locations:

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

		let response = await client.messages.create({
			model     : 'claude-sonnet-4-5-20250929',
			max_tokens: 4096,
			system    : systemPrompt,
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

						toolResults.push({
							type       : 'tool_result',
							tool_use_id: content.id,
							content    : JSON.stringify(result, null, 2),
						});
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : 'Unknown error';
						onDebugLog?.('error', 'Tool Error', `Error in ${toolName}: ${errorMessage}`, JSON.stringify(toolInput, null, 2));
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
				system    : systemPrompt,
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

		// Add Claude's technical response (extract text only, no tool_use blocks)
		const technicalAnswer = response.content
			.filter((c) => c.type === 'text')
			.map((c) => c.text)
			.join('\n');

		// Only add the technical answer if it's not empty
		if (technicalAnswer.trim()) {
			simplificationMessages.push({
				role   : 'assistant',
				content: technicalAnswer,
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
				system    : systemPrompt,
				messages,
			});

			const answer = answerResponse.content
				.filter((c) => c.type === 'text')
				.map((c) => c.text)
				.join('\n');

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

Guidelines:
- Start with clear business language (customer, order, discount, price, invoice, delivery, etc.)
- Explain WHAT happens and WHY it matters
- Avoid unnecessary technical jargon that doesn't help understanding
- BUT: If they ask for technical details (file names, class names, code locations, etc.), provide them directly
- If they ask "what file", "what class", "where in the code" - answer specifically with file paths and names
- Don't hide technical information when directly requested - support staff are capable of handling it
- If you created a CSV file, mention where it was saved

Balance: Be clear and accessible, but not dumbed down. Respect that support staff can handle technical details when needed.`,
		});

		// Get the simplified response (no tools needed here, CSV already created)
		const simplifiedResponse = await client.messages.create({
			model     : 'claude-sonnet-4-5-20250929',
			max_tokens: 4096,
			messages  : simplificationMessages,
		});

		onProgress?.('Finalizing answer...');

		// Extract and return the simplified answer
		return simplifiedResponse.content
			.filter((c) => c.type === 'text')
			.map((c) => c.text)
			.join('\n');
	}

	async generateTldr(messageContent: string): Promise<string> {
		const client = await this.ensureClient();

		const response = await client.messages.create({
			model     : 'claude-sonnet-4-5-20250929',
			max_tokens: 1024,
			messages  : [
				{
					role   : 'user',
					content: `Please provide a very short TL;DR (Too Long; Didn't Read) summary of this answer in 2-3 sentences maximum. Keep it in the SAME LANGUAGE as the original text. Focus on the key points only.

Original answer:
${messageContent}`,
				},
			],
		});

		return response.content
			.filter((c) => c.type === 'text')
			.map((c) => c.text)
			.join('\n');
	}
}
