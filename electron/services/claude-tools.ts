import {app} from 'electron';
import * as fs from 'fs/promises';
import path from 'path';
import {z} from 'zod';
import type {DatabaseService} from './database-service';
import type {GitHubService} from './github-service';
import type {SchemaIndexService} from './schema-index-service';

export type DebugLogFn = (
	type: 'query' | 'tool' | 'api' | 'error' | 'info',
	category: string,
	message: string,
	details?: string,
) => void;

export interface ClaudeToolOptions {
	databaseService: DatabaseService;
	githubService: GitHubService;
	schemaIndexService: SchemaIndexService;
	databaseIds: string[];
	databaseName?: string;
	dbHostOverride?: string;
	githubBranchOverride?: string;
	onProgress?: (status: string) => void;
	onDebugLog?: DebugLogFn;
	queryResults: Array<{ query: string; data: any[] }>;
}

export interface ClaudeToolsResult {
	tools: any[];
	hasGitHub: boolean;
	resetSearchCounter: () => void;
}

type DbConfig = { id: string; name: string; host: string; database?: string };

function truncateLargeToolResult(
	result: unknown,
	maxRows: number  = 100,
	maxLines: number = 500,
): { truncated: boolean; data: unknown } {
	const queryResult = result as { rows?: any[]; rowCount?: number; [key: string]: any };

	if (queryResult.rows && Array.isArray(queryResult.rows)) {
		const totalRows = queryResult.rows.length;
		if (totalRows > maxRows) {
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

	if (typeof result === 'string' && result.includes('\n')) {
		const lines = result.split('\n');
		if (lines.length > maxLines) {
			const truncatedContent = lines.slice(0, maxLines).join('\n');
			const remainingLines   = lines.length - maxLines;
			const guidanceMessage  = `

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

	if (Array.isArray(result)) {
		const maxResults = 10;
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

function extractTableNames(sql: string): string[] {
	const names: string[] = [];
	const re              = /\b(?:FROM|JOIN)\s+`?([a-zA-Z0-9_]+)`?/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(sql)) !== null) {
		if (m[1]) {
			names.push(m[1]);
		}
	}
	return Array.from(new Set(names));
}

function extractPossibleColumnNamesSingleTable(sql: string): string[] {
	// Extract column names from entire SQL, not just WHERE clause
	// This catches columns in SELECT, CASE WHEN, WHERE, ORDER BY, GROUP BY, etc.
	
	// Remove string literals to avoid false matches
	let cleanSql = sql
		.replace(/'[^']*'/g, ' ')
		.replace(/"[^"]*"/g, ' ');
	
	// Remove AS aliases (the word after AS is not a column)
	cleanSql = cleanSql.replace(/\bAS\s+[a-zA-Z_][a-zA-Z0-9_]*/gi, ' ');
	
	// Find all potential identifiers
	const tokens = cleanSql
		.match(/[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?|`[a-zA-Z0-9_]+`(?:\.`[a-zA-Z0-9_]+`)?/g) || [];

	const out: string[] = [];
	for (const raw of tokens) {
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
		// Skip common SQL functions
		if (['COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'COALESCE', 'IFNULL', 'IF', 'CONCAT', 'LENGTH', 'SUBSTRING', 'TRIM', 'UPPER', 'LOWER', 'DATE', 'NOW', 'YEAR', 'MONTH', 'DAY'].includes(upper)) {
			continue;
		}
		if (ident.length <= 1) {
			continue;
		}
		out.push(ident);
	}
	return Array.from(new Set(out));
}

function suggestColumnsFromTable(
	table: { tableName: string; columns: Array<{ columnName: string }> },
	needle: string,
	limit: number = 10,
): Array<{ tableName: string; columnName: string }> {
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
}

async function preflightQueryAgainstSchemaIndex(
	schemaIndexService: SchemaIndexService,
	configId: string,
	sql: string,
): Promise<{ ok: boolean; error?: string; hints?: any }> {
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

	const hasJoin = /\bJOIN\b/i.test(sql);
	if (tables.length === 1 && !hasJoin) {
		const table = schemaIndexService.getTable(index, tables[0]);
		if (table) {
			const columnSet  = new Set(table.columns.map((c) => c.columnName.toLowerCase()));
			const candidates = extractPossibleColumnNamesSingleTable(sql)
				.filter((c) => c.toLowerCase() !== table.tableName.toLowerCase());

			const missingCols = candidates.filter((c) => !columnSet.has(c.toLowerCase()));
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
}

export async function exportToCsvFile(filename: string, data: Array<Record<string, unknown>>): Promise<Record<string, unknown>> {
	if (data.length === 0) {
		return {error: 'No data to export'};
	}

	const headers           = Object.keys(data[0]);
	const csvRows: string[] = [];
	csvRows.push(headers.map((h) => escapeCsvValue(h)).join(','));
	for (const row of data) {
		const values = headers.map((h) => escapeCsvValue(String(row[h] ?? '')));
		csvRows.push(values.join(','));
	}

	const csvContent   = csvRows.join('\n');
	const downloadsDir = app.getPath('downloads');
	const filePath     = path.join(downloadsDir, filename);
	await fs.writeFile(filePath, csvContent, 'utf-8');

	return {
		success : true,
		filePath,
		rowCount: data.length,
		message : `CSV file saved to Downloads folder: ${filename}`,
	};
}

function escapeCsvValue(value: string): string {
	if (value.includes(',') || value.includes('"') || value.includes('\n')) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

export async function createClaudeTools(options: ClaudeToolOptions): Promise<ClaudeToolsResult> {
	const {toolDefinition} = await import('@tanstack/ai');

	const queryDatabaseDef = toolDefinition({
		name        : 'query_database',
		description : 'Execute a READ-ONLY SQL query. IMPORTANT: Before using this tool, ALWAYS call get_table_schema_cached first to verify exact column names - DO NOT guess column names! Use for questions about specific records (orders, customers, returns), counts, lists, or data lookups.',
		inputSchema : z.object({
			dbId : z.string().describe('Database connection ID from the available connections'),
			query: z.string().describe('SELECT/SHOW/DESCRIBE/EXPLAIN query using ONLY verified column names from get_table_schema_cached. Always use LIMIT for large result sets.'),
		}),
		outputSchema: z.any(),
	});

	const listTablesDef = toolDefinition({
		name        : 'list_tables',
		description : 'List all tables for a database.',
		inputSchema : z.object({
			dbId: z.string(),
		}),
		outputSchema: z.array(z.string()),
	});

	const describeTableDef = toolDefinition({
		name        : 'describe_table',
		description : 'Get schema information for a table in a database.',
		inputSchema : z.object({
			dbId      : z.string(),
			table_name: z.string(),
		}),
		outputSchema: z.any(),
	});

	const searchSchemaDef = toolDefinition({
		name        : 'search_schema',
		description : 'Find table names by keyword. Use FIRST when you need to find which table contains certain data (e.g., search "order" to find order-related tables, search "customer" to find customer tables).',
		inputSchema : z.object({
			dbId : z.string(),
			query: z.string().describe('Keyword to search for (e.g., "order", "customer", "invoice", "return")'),
			limit: z.number().optional(),
		}),
		outputSchema: z.any(),
	});

	const getTableSchemaCachedDef = toolDefinition({
		name        : 'get_table_schema_cached',
		description : 'REQUIRED before query_database! Get exact column names for a table from the schema index. Returns all columns with their types. Use this to verify column names before writing any SQL query.',
		inputSchema : z.object({
			dbId      : z.string(),
			table_name: z.string().describe('Exact table name (e.g., "customers", "orders", "order_lines")'),
		}),
		outputSchema: z.any(),
	});

	const exportToCsvDef = toolDefinition({
		name        : 'export_to_csv',
		description : 'Export query results to a CSV file in the Downloads folder.',
		inputSchema : z.object({
			dbId    : z.string(),
			query   : z.string(),
			filename: z.string(),
		}),
		outputSchema: z.any(),
	});

	const searchCodeDef = toolDefinition({
		name        : 'search_code',
		description : 'Search repository code. USE THIS for "how does X work", UI navigation, feature logic, error causes. Do NOT use for data lookups (use query_database instead). Supports path: or file: prefixes.',
		inputSchema : z.object({
			query: z.string().describe('Search query. Supports path:folder or file:name.php prefixes to narrow scope.'),
		}),
		outputSchema: z.any(),
	});

	const searchCodeContextDef = toolDefinition({
		name        : 'search_code_context',
		description : 'PREFERRED for understanding code. Returns actual source snippets with line numbers. Use for "how to", "where is the setting", understanding feature logic. Do NOT use for data lookups.',
		inputSchema : z.object({
			query        : z.string().describe('Search query. Supports path:folder or file:name.php prefixes to narrow scope.'),
			max_files    : z.number().int().min(1).max(5).optional().describe('Max files to return snippets from (default: 3)'),
			context_lines: z.number().int().min(5).max(120).optional().describe('Lines of context around each match (default: 40)'),
		}),
		outputSchema: z.any(),
	});

	const readFileDef = toolDefinition({
		name        : 'read_file',
		description : 'Read an ENTIRE file from the repository. WARNING: For large files (1000+ lines), prefer read_file_section with specific line ranges instead. Use this only for small files or when you need the complete file.',
		inputSchema : z.object({
			file_path: z.string().describe('Path to the file in the repository'),
		}),
		outputSchema: z.any(),
	});

	const listFilesDef = toolDefinition({
		name        : 'list_files',
		description : 'List files in a directory in the configured GitHub repository.',
		inputSchema : z.object({
			directory_path: z.string(),
		}),
		outputSchema: z.any(),
	});

	const getRepositoryStructureDef = toolDefinition({
		name        : 'get_repository_structure',
		description : 'Get the complete file tree structure of the configured GitHub repository.',
		inputSchema : z.object({}),
		outputSchema: z.any(),
	});
	const {
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
		  }                         = options;

	const configs          = await databaseService.getConfigs();
	const dbConfigs        = configs.filter((c) => databaseIds.includes(c.id)) as DbConfig[];
	const dbConfigById     = new Map(dbConfigs.map((c) => [c.id, c]));
	const allowedDbDisplay = dbConfigs
		.map((c) => `${c.name} (id: ${c.id})`)
		.join(', ');

	const githubConfig = await githubService.getConfig();
	const localRepoUrl = githubService.getLocalRepoUrl();
	const hasGitHub    = !!githubConfig || !!localRepoUrl;
	if (githubConfig) {
		console.log('[ClaudeService] GitHub repo:', `${githubConfig.owner}/${githubConfig.repo}@${githubConfig.branch}`);
	}
	if (localRepoUrl) {
		console.log('[ClaudeService] Local repo URL:', localRepoUrl);
	}

	const tools: Array<any> = [];
	let codeSearchCallCount = 0;

	if (databaseName && databaseIds.length > 0) {
		const ensureDbConfig = (dbId: string): DbConfig | null => {
			const config = dbConfigById.get(dbId);
			return config || null;
		};

		// ============================================================
		// SCHEMA TOOLS FIRST - LLMs tend to use tools that appear first
		// ============================================================

		// 1. get_table_schema_cached - MOST IMPORTANT, must be called before query_database
		tools.push(getTableSchemaCachedDef.server(async (args) => {
			const {dbId, table_name} = args as { dbId: string; table_name: string };
			const config             = ensureDbConfig(dbId);
			if (!config) {
				return {error: `Database not available for this chat: ${dbId}. Allowed: ${allowedDbDisplay}`};
			}
			if (!databaseName) {
				return {error: 'Database name must be provided'};
			}

			const tableName = table_name;
			onProgress?.(`Reading schema index: ${tableName}`);
			onDebugLog?.('tool', 'Schema Index', `Reading cached schema for: ${tableName}`, 'Tool: get_table_schema_cached');

			const index = await schemaIndexService.loadIndex(config.id);
			if (!index) {
				return {
					exists : false,
					message: 'No local schema index found. Generate it in Settings → Database Connection → Database Schema Index.',
					databaseName,
				};
			}

			const table = schemaIndexService.getTable(index, tableName);
			if (!table) {
				return {
					exists        : true,
					found         : false,
					databaseName,
					generatedAtIso: index.generatedAtIso,
					message       : `Table not found in local schema index: ${tableName}`,
				};
			}

			const maxColumns = 200;
			const columns    = table.columns.slice(0, maxColumns).map((c) => ({
				columnName     : c.columnName,
				dataType       : c.dataType,
				columnType     : c.columnType,
				ordinalPosition: c.ordinalPosition,
				isNullable     : c.isNullable,
			}));

			return {
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
		}));

		// 2. search_schema - find table names by keyword
		tools.push(searchSchemaDef.server(async (args) => {
			const {dbId, query, limit} = args as { dbId: string; query: string; limit?: number };
			const config               = ensureDbConfig(dbId);
			if (!config) {
				return {error: `Database not available for this chat: ${dbId}. Allowed: ${allowedDbDisplay}`};
			}
			if (!databaseName) {
				return {error: 'Database name must be provided'};
			}
			const effectiveLimit = typeof limit === 'number' ? limit : 10;
			onProgress?.(`Searching schema index: ${query}`);
			onDebugLog?.('tool', 'Schema Index', `Searching schema index for: ${query}`, 'Tool: search_schema');

			const index = await schemaIndexService.loadIndex(config.id);
			if (!index) {
				return {
					exists : false,
					message: 'No local schema index found. Generate it in Settings → Database Connection → Database Schema Index.',
					databaseName,
				};
			}

			return {
				exists        : true,
				databaseName,
				generatedAtIso: index.generatedAtIso,
				source        : index.source,
				matches       : schemaIndexService.searchSchema(index, query, effectiveLimit),
			};
		}));

		// 3. list_tables - list all tables
		tools.push(listTablesDef.server(async (args) => {
			const {dbId} = args as { dbId: string };
			const config = ensureDbConfig(dbId);
			if (!config) {
				return {error: `Database not available for this chat: ${dbId}. Allowed: ${allowedDbDisplay}`};
			}
			if (!databaseName) {
				return {error: 'Database name must be provided'};
			}

			onProgress?.(`Listing tables in ${config.name}`);
			onDebugLog?.('query', 'Database Schema', `Listing tables in ${databaseName}`, 'SHOW TABLES');
			const result = await databaseService.listTables(config.id, databaseName, dbHostOverride);
			onDebugLog?.('query', 'Database Schema', `Found ${(result as string[]).length} tables`);
			return result;
		}));

		// 4. describe_table - get live schema from database
		tools.push(describeTableDef.server(async (args) => {
			const {dbId, table_name} = args as { dbId: string; table_name: string };
			const config             = ensureDbConfig(dbId);
			if (!config) {
				return {error: `Database not available for this chat: ${dbId}. Allowed: ${allowedDbDisplay}`};
			}
			const tableName = table_name;
			onProgress?.(`Describing table: ${tableName}`);
			onDebugLog?.('query', 'Database Schema', `Describing table: ${tableName}`, `DESCRIBE ${tableName}`);
			return await databaseService.getTableSchema(
				config.id,
				tableName,
				databaseName,
				dbHostOverride,
			);
		}));

		// ============================================================
		// QUERY TOOLS AFTER SCHEMA TOOLS
		// ============================================================

		// 5. query_database - execute SQL (AFTER schema tools)
		tools.push(queryDatabaseDef.server(async (args) => {
			const {dbId, query} = args as { dbId: string; query: string };
			const config        = ensureDbConfig(dbId);
			if (!config) {
				return {error: `Database not available for this chat: ${dbId}. Allowed: ${allowedDbDisplay}`};
			}
			if (!databaseName) {
				return {error: 'Database name must be provided'};
			}

			const shortQuery = query.length > 60 ? `${query.substring(0, 60)}...` : query;
			onProgress?.(`Running query: ${shortQuery}`);
			onDebugLog?.('query', 'Database Query', `Executing query on ${databaseName}`, query);

			const preflight = await preflightQueryAgainstSchemaIndex(schemaIndexService, config.id, query);
			if (!preflight.ok) {
				const result = {
					error         : preflight.error,
					hints         : preflight.hints,
					recommendation: 'You MUST use get_table_schema_cached FIRST to verify column names before running any query.',
				};
				onDebugLog?.('tool', 'Schema Index', 'Preflight blocked a likely-invalid query', JSON.stringify(result, null, 2));
				return result;
			}

			const result = await databaseService.executeQuery(
				config.id,
				query,
				databaseName,
				dbHostOverride,
			);

			const queryResultObj = result as { rows?: any[]; rowCount?: number };
			if (queryResultObj.rows && queryResultObj.rows.length > 0) {
				queryResults.push({query, data: queryResultObj.rows});
			}

			onDebugLog?.('query', 'Database Query', `Query completed - ${queryResultObj.rowCount || 0} rows returned`);

			const {data} = truncateLargeToolResult(result);
			return data;
		}));

		// 6. export_to_csv
		tools.push(exportToCsvDef.server(async (args) => {
			const {dbId, query, filename} = args as { dbId: string; query: string; filename: string };
			const config                  = ensureDbConfig(dbId);
			if (!config) {
				return {error: `Database not available for this chat: ${dbId}. Allowed: ${allowedDbDisplay}`};
			}
			if (!databaseName) {
				return {error: 'Database name must be provided'};
			}

			onProgress?.(`Exporting to CSV: ${filename}.csv`);
			onDebugLog?.('tool', 'CSV Export', `Exporting query results to ${filename}.csv`, query);

			const queryResult = await databaseService.executeQuery(
				config.id,
				query,
				databaseName,
				dbHostOverride,
			);

			const queryResultObj = queryResult as { rows?: any[]; rowCount?: number };
			if (!queryResultObj.rows || queryResultObj.rows.length === 0) {
				return {error: 'Query returned no data to export'};
			}

			const now          = new Date();
			const dateStr      = now.toISOString().split('T')[0];
			const timeStr      = now.toTimeString().split(' ')[0].replace(/:/g, '-');
			const fullFilename = `${filename}_${dateStr}_${timeStr}.csv`;

			return await exportToCsvFile(fullFilename, queryResultObj.rows);
		}));
	}

	if (hasGitHub) {
		tools.push(searchCodeDef.server(async (args) => {
			const {query} = args as { query: string };
			codeSearchCallCount += 1;
			const isOverSoftLimit = codeSearchCallCount > 15;
			if (isOverSoftLimit) {
				onDebugLog?.('tool', 'Ripgrep', `Code search #${codeSearchCallCount} (over soft limit of 15). Consider using read_file instead.`, query);
			}
			onProgress?.(`Searching code: ${query.substring(0, 40)}...`);
			onDebugLog?.('tool', 'GitHub', `Searching code: ${query}`, 'Tool: search_code');
			if (localRepoUrl) {
				const branch = githubBranchOverride?.trim() || githubConfig?.branch || 'main';
				onDebugLog?.('tool', 'Ripgrep', `Searching local repo (${branch})`);
				try {
					const localResult = await githubService.searchCodeLocal(query, branch, localRepoUrl);
					const meta        = githubService.getLastLocalSearchMeta();
					if (meta) {
						onDebugLog?.(
							'tool',
							'Ripgrep',
							`Search completed in ${meta.durationMs}ms: mode=${meta.mode}, tokens=${meta.tokens.join(', ') || '(none)'}${meta.pathSpecs.length > 0 ? `, pathSpecs=${meta.pathSpecs.join(', ')}` : ''}`,
							`Found ${(localResult as any).length || 0} files in ${meta.worktreePath}`,
						);
					} else {
						onDebugLog?.('tool', 'Ripgrep', `Local search completed - found ${(localResult as any).length || 0} results`);
					}
					const {data} = truncateLargeToolResult(localResult);
					if (isOverSoftLimit) {
						return {data, note: `Search #${codeSearchCallCount}. Tip: use read_file to read specific files you already found.`};
					}
					return data;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					onDebugLog?.('error', 'Ripgrep', 'Local search failed, falling back to GitHub API', message);
				}
			}
			const result = await githubService.searchCode(query, githubBranchOverride);
			onDebugLog?.('tool', 'GitHub', `GitHub API search completed - found ${(result as any).length || 0} results`);
			const {data} = truncateLargeToolResult(result);
			return data;
		}));

		tools.push(searchCodeContextDef.server(async (args) => {
			const {query, max_files, context_lines} = args as { query: string; max_files?: number; context_lines?: number };
			const maxFiles                          = typeof max_files === 'number' ? max_files : 3;
			const ctxLines                          = typeof context_lines === 'number' ? context_lines : 40;

			// Count towards code search limit (shared with search_code)
			codeSearchCallCount += 1;
			const isOverSoftLimit = codeSearchCallCount > 15;
			if (isOverSoftLimit) {
				onDebugLog?.('tool', 'Ripgrep', `Code search #${codeSearchCallCount} (over soft limit of 15). Consider using read_file instead.`, query);
			}

			onProgress?.(`Searching code context: ${query.substring(0, 40)}...`);
			onDebugLog?.('tool', 'GitHub', `Searching code context: ${query}`, 'Tool: search_code_context');

			const branch = githubBranchOverride?.trim() || githubConfig?.branch || 'main';
			const url    = githubService.getLocalRepoUrl();
			if (!url) {
				return {error: 'Local repository is not configured. Configure Local Git Sync in Settings.'};
			}

			const startTime = Date.now();
			const results   = await githubService.searchCodeLocal(query, branch, url);
			const meta      = githubService.getLastLocalSearchMeta();
			if (meta) {
				onDebugLog?.(
					'tool',
					'Ripgrep',
					`Context search in ${meta.durationMs}ms: mode=${meta.mode}, tokens=${meta.tokens.join(', ') || '(none)'}${meta.pathSpecs.length > 0 ? `, pathSpecs=${meta.pathSpecs.join(', ')}` : ''}`,
					`Found ${results.length} files in ${meta.worktreePath}`,
				);
			}

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

			const totalMs = Date.now() - startTime;
			onDebugLog?.('tool', 'Ripgrep', `Context extraction completed in ${totalMs}ms`, `Extracted ${contexts.length} snippets`);

			if (isOverSoftLimit) {
				return {data: contexts, note: `Search #${codeSearchCallCount}. Tip: use read_file or read_file_section to read specific files you already found.`};
			}
			return contexts;
		}));

		// read_file_section: Read a specific section of a file by line range (efficient for large files)
		const readFileSectionDef = toolDefinition({
			name        : 'read_file_section',
			description : 'Read a specific section of a file by line range. MUCH more efficient than read_file for large files (e.g., 5000+ lines). Use this when you know the file path from a previous search and need to see a specific function or class.',
			inputSchema : z.object({
				file_path : z.string().describe('Path to the file in the repository'),
				start_line: z.number().int().min(1).describe('First line to read (1-based)'),
				end_line  : z.number().int().min(1).describe('Last line to read (1-based). Max range: 300 lines.'),
			}),
			outputSchema: z.any(),
		});

		tools.push(readFileSectionDef.server(async (args) => {
			const {file_path, start_line, end_line} = args as { file_path: string; start_line: number; end_line: number };
			const clampedEnd                        = Math.min(end_line, start_line + 300);
			onProgress?.(`Reading ${file_path}:${start_line}-${clampedEnd}`);
			onDebugLog?.('tool', 'GitHub', `Reading file section: ${file_path} lines ${start_line}-${clampedEnd}`, 'Tool: read_file_section');

			const branch = githubBranchOverride?.trim() || githubConfig?.branch || 'main';
			const url    = githubService.getLocalRepoUrl();
			if (!url) {
				// Fallback: read full file and slice
				const fullContent = await githubService.getFileContent(file_path, githubBranchOverride);
				if (typeof fullContent === 'string') {
					const lines = fullContent.split('\n');
					return {
						file   : file_path,
						lines  : `${start_line}-${clampedEnd}`,
						total  : lines.length,
						content: lines.slice(start_line - 1, clampedEnd).map((l, i) => `${start_line + i}: ${l}`).join('\n'),
					};
				}
				return fullContent;
			}

			const snippet = await githubService.readFileLocalSnippet(file_path, branch, url, start_line, clampedEnd);
			return {
				file   : file_path,
				lines  : `${start_line}-${clampedEnd}`,
				content: snippet,
			};
		}));

		tools.push(readFileDef.server(async (args) => {
			const {file_path} = args as { file_path: string };
			onProgress?.(`Reading file: ${file_path}`);
			onDebugLog?.('tool', 'GitHub', `Reading file: ${file_path}`, 'Tool: read_file');
			if (localRepoUrl) {
				onDebugLog?.('tool', 'Ripgrep', 'Attempting local file read', file_path);
			}
			const result = await githubService.getFileContent(file_path, githubBranchOverride);
			onDebugLog?.('tool', 'GitHub', `File read successfully: ${file_path}`);
			const {data} = truncateLargeToolResult(result);
			return data;
		}));

		tools.push(listFilesDef.server(async (args) => {
			const {directory_path} = args as { directory_path: string };
			onProgress?.(`Listing files in: ${directory_path || '/'} `);
			onDebugLog?.('tool', 'GitHub', `Listing files in: ${directory_path || '/'}`, 'Tool: list_files');
			if (localRepoUrl) {
				onDebugLog?.('tool', 'Ripgrep', 'Attempting local directory listing', directory_path || '/');
			}
			const result = await githubService.listFiles(directory_path, githubBranchOverride);
			onDebugLog?.('tool', 'GitHub', `Listed ${(result as any).length || 0} files`);
			const {data} = truncateLargeToolResult(result);
			return data;
		}));

		tools.push(getRepositoryStructureDef.server(async () => {
			onProgress?.('Getting repository structure');
			onDebugLog?.('tool', 'GitHub', 'Getting repository structure', 'Tool: get_repository_structure');
			if (localRepoUrl) {
				onDebugLog?.('tool', 'Ripgrep', 'Attempting local tree fetch', localRepoUrl);
			}
			const result = await githubService.getTree(true, githubBranchOverride);
			onDebugLog?.('tool', 'GitHub', 'Repository structure retrieved');
			const {data} = truncateLargeToolResult(result);
			return data;
		}));
	}

	return {
		tools,
		hasGitHub,
		resetSearchCounter: () => {
			codeSearchCallCount = 0;
		},
	};
}
