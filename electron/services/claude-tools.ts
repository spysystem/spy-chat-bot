import type Anthropic from '@anthropic-ai/sdk';
import {app} from 'electron';
import * as fs from 'fs/promises';
import path from 'path';
import type {DatabaseService} from './database-service';
import type {GitHubService} from './github-service';
import type {KnowledgeService} from './knowledge-service';
import type {CommitSummary} from './local-repo-service';
import type {SchemaIndexFileV1, SchemaIndexService} from './schema-index-service';
import type {SentryService} from './sentry-service';
import type {SpyCodeAiMcpService, SpySearchCodeArgs} from './spy-code-ai-mcp-service';

export type DebugLogFn = (
	type: 'query' | 'tool' | 'api' | 'error' | 'info',
	category: string,
	message: string,
	details?: string,
) => void;

/** What the agent looked at, shown under "Details" and fed to the working summary. */
export interface EvidenceItem {
	kind: 'sql' | 'schema' | 'code_search' | 'file' | 'history' | 'csv' | 'knowledge' | 'mcp' | 'sentry';
	label: string;
	detail?: string;
}

interface ClarificationRequest {
	question: string;
	options?: string[];
	allowFreeText: boolean;
}

export interface ToolContext {
	databaseService: DatabaseService;
	githubService: GitHubService;
	schemaIndexService: SchemaIndexService;
	spyCodeAiMcpService: SpyCodeAiMcpService;
	knowledgeService: KnowledgeService;
	sentryService: SentryService;
	systemKey?: string;
	databaseIds: string[];
	databaseName?: string;
	dbHostOverride?: string;
	branch?: string;
	onProgress?: (status: string) => void;
	onDebugLog?: DebugLogFn;
	evidence: EvidenceItem[];
}

export interface ToolRunResult {
	content: string;
	isError?: boolean;
	clarification?: ClarificationRequest;
}

interface AgentTool {
	definition: Anthropic.Tool;
	run: (input: Record<string, unknown>) => Promise<ToolRunResult>;
}

export interface AgentToolset {
	tools: AgentTool[];
	capabilities: {
		database: boolean;
		schemaIndex: boolean;
		localCode: boolean;
		remoteCode: boolean;
		spyCodeAi: boolean;
		sentry: boolean;
	};
}

type DbConfig = { id: string; name: string; host: string };

const MAX_TOOL_RESULT_CHARS = 60_000;
const MAX_QUERY_ROWS        = 200;
const MAX_CELL_CHARS        = 300;
const MAX_FILE_LINES        = 1500;

class ToolInputError extends Error {
}

function str(input: Record<string, unknown>, key: string, required: true): string;
function str(input: Record<string, unknown>, key: string, required?: false): string | undefined;
function str(input: Record<string, unknown>, key: string, required = false): string | undefined {
	const value = input[key];
	if (value === undefined || value === null || value === '') {
		if (required) {
			throw new ToolInputError(`Missing required parameter "${key}"`);
		}
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new ToolInputError(`Parameter "${key}" must be a string`);
	}
	return value;
}

function int(input: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
	const value = input[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		throw new ToolInputError(`Parameter "${key}" must be a number`);
	}
	return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function bool(input: Record<string, unknown>, key: string): boolean | undefined {
	const value = input[key];
	return typeof value === 'boolean' ? value : undefined;
}

function capText(text: string, limit: number = MAX_TOOL_RESULT_CHARS): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, limit)}\n\n[Output truncated at ${limit} characters - narrow the request to see the rest.]`;
}

function toJson(value: unknown): string {
	return capText(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
}

function formatCell(value: unknown): string {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	let text: string;
	if (value instanceof Date) {
		text = value.toISOString();
	} else if (Buffer.isBuffer(value)) {
		text = `<binary ${value.length} bytes>`;
	} else if (typeof value === 'object') {
		text = JSON.stringify(value);
	} else {
		text = String(value);
	}
	text = text.replace(/\t/g, ' ').replace(/\r?\n/g, '\\n');
	return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

function formatRows(columns: string[], rows: Array<Record<string, unknown>>, maxRows: number): string {
	if (rows.length === 0) {
		return 'Query returned 0 rows.';
	}
	const cols  = columns.length > 0 ? columns : Object.keys(rows[0]);
	const shown = rows.slice(0, maxRows);
	const lines = [cols.join('\t'), ...shown.map((row) => cols.map((c) => formatCell(row[c])).join('\t'))];
	const note  = rows.length > shown.length
		? `\n\n[Showing ${shown.length} of ${rows.length} rows. Use aggregation, filters or LIMIT to narrow the result, or export_to_csv for the full list.]`
		: `\n\n(${rows.length} row${rows.length === 1 ? '' : 's'})`;
	return capText(lines.join('\n') + note);
}

function numberLines(content: string, startLine: number): string {
	return content.split('\n').map((line, index) => `${startLine + index}\t${line}`).join('\n');
}

function csvValue(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	const text = value instanceof Date ? value.toISOString() : typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : String(value);
	return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportToCsvFile(baseName: string, rows: Array<Record<string, unknown>>, columns: string[]): Promise<{
	filePath: string;
	rowCount: number
}> {
	const safeBase = baseName.replace(/\.csv$/i, '').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^[.\s]+/, '').slice(0, 80) || 'export';
	const now      = new Date();
	const stamp    = `${now.toISOString().slice(0, 10)}_${now.toTimeString().slice(0, 8).replace(/:/g, '-')}`;
	const filePath = path.join(app.getPath('downloads'), `${safeBase}_${stamp}.csv`);
	const cols     = columns.length > 0 ? columns : Object.keys(rows[0] ?? {});
	const lines    = [cols.map(csvValue).join(','), ...rows.map((row) => cols.map((c) => csvValue(row[c])).join(','))];
	// BOM so Excel opens UTF-8 (æ, ø, å) correctly.
	await fs.writeFile(filePath, '﻿' + lines.join('\r\n'), 'utf-8');
	return {filePath, rowCount: rows.length};
}

function tool(
	name: string,
	description: string,
	properties: Record<string, unknown>,
	required: string[],
	run: AgentTool['run'],
): AgentTool {
	return {
		definition: {
			name,
			description,
			input_schema: {type: 'object', properties, required},
		},
		run,
	};
}

export async function createAgentTools(ctx: ToolContext): Promise<AgentToolset> {
	const {
			  databaseService, githubService, schemaIndexService, spyCodeAiMcpService, knowledgeService, sentryService, systemKey,
			  databaseIds, databaseName, dbHostOverride, branch, onProgress, onDebugLog, evidence,
		  } = ctx;

	const configs            = await databaseService.getConfigs();
	const dbConfigs          = configs.filter((c) => databaseIds.includes(c.id)) as DbConfig[];
	const hasDatabase        = !!databaseName && dbConfigs.length > 0;
	const githubConfig       = await githubService.getConfig();
	const localRepoUrl       = githubService.getLocalRepoUrl();
	const hasRemote          = !localRepoUrl && !!githubConfig?.token && !!githubConfig?.owner && !!githubConfig?.repo;
	const hasSpyCodeAi       = await spyCodeAiMcpService.isConfigured();
	const hasSentry          = await sentryService.isConfigured();
	const tools: AgentTool[] = [];

	const schemaIndexes   = new Map<string, SchemaIndexFileV1 | null>();
	const loadSchemaIndex = async (configId: string): Promise<SchemaIndexFileV1 | null> => {
		if (!schemaIndexes.has(configId)) {
			const index = await schemaIndexService.loadIndex(configId, {
				branch          : branch,
				fallbackBranches: githubConfig?.branch ? [githubConfig.branch] : [],
			}).catch(() => null);
			schemaIndexes.set(configId, index);
		}
		return schemaIndexes.get(configId) ?? null;
	};
	const hasSchemaIndex  = hasDatabase && !!(await loadSchemaIndex(dbConfigs[0].id));

	const resolveDb    = (input: Record<string, unknown>): DbConfig => {
		const requested = str(input, 'db_id');
		if (!requested) {
			return dbConfigs[0];
		}
		const config = dbConfigs.find((c) => c.id === requested || c.name === requested);
		if (!config) {
			throw new ToolInputError(`Unknown db_id "${requested}". Available: ${dbConfigs.map((c) => `${c.name} (${c.id})`).join(', ')}`);
		}
		return config;
	};
	const dbIdProperty = dbConfigs.length > 1
		? {
			db_id: {
				type       : 'string',
				description: `Connection to use. One of: ${dbConfigs.map((c) => `${c.id} (${c.name})`).join(', ')}. Defaults to the first.`,
			},
		}
		: {};

	const searchSchemaIndex = (index: SchemaIndexFileV1, query: string, limit: number) => {
		// The index search matches one needle; score each word separately so
		// "shopify order" finds tables matching either.
		const words  = query.split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2);
		const merged = new Map<string, { score: number; matchingColumns: Set<string> }>();
		for (const word of words.length > 0 ? words : [query]) {
			for (const hit of schemaIndexService.searchSchema(index, word, 50)) {
				const entry = merged.get(hit.tableName) ?? {score: 0, matchingColumns: new Set<string>()};
				entry.score += hit.score;
				hit.matchingColumns.forEach((c) => entry.matchingColumns.add(c));
				merged.set(hit.tableName, entry);
			}
		}
		return Array.from(merged.entries())
			.sort((a, b) => b[1].score - a[1].score)
			.slice(0, limit)
			.map(([table, entry]) => ({table, matchingColumns: Array.from(entry.matchingColumns).slice(0, 12)}));
	};

	// ── Database ─────────────────────────────────────────────────────────────
	if (hasDatabase) {
		tools.push(tool(
			'search_schema',
			'Find database tables whose table or column names match keywords (English, as used in the schema, e.g. "shopify order", "consignment", "return"). Returns table names with the matching columns.',
			{
				query: {type: 'string', description: 'One or more keywords'},
				limit: {type: 'integer', description: 'Max tables to return (default 15)'},
				...dbIdProperty,
			},
			['query'],
			async (input) => {
				const db    = resolveDb(input);
				const query = str(input, 'query', true);
				const limit = int(input, 'limit', 1, 50) ?? 15;
				onProgress?.(`Searching schema: ${query}`);
				const index = await loadSchemaIndex(db.id);
				if (index) {
					const matches = searchSchemaIndex(index, query, limit);
					evidence.push({kind: 'schema', label: `search_schema "${query}"`, detail: `${matches.length} tables`});
					return {content: matches.length > 0 ? toJson(matches) : `No tables match "${query}". Try other or shorter keywords.`};
				}
				// No index: fall back to table names from the live database.
				const tables  = await databaseService.listTables(db.id, databaseName, dbHostOverride);
				const words   = query.toLowerCase().split(/\s+/).filter(Boolean);
				const matches = tables.filter((t) => words.some((w) => t.toLowerCase().includes(w))).slice(0, limit);
				evidence.push({kind: 'schema', label: `search_schema "${query}"`, detail: `${matches.length} tables (live)`});
				return {content: matches.length > 0 ? toJson(matches) : `No table names contain "${query}".`};
			},
		));

		tools.push(tool(
			'describe_table',
			'Get the columns (name and type), primary key and foreign keys of a table. Check this before writing SQL against a table you have not described in this conversation.',
			{
				table: {type: 'string', description: 'Exact table name'},
				...dbIdProperty,
			},
			['table'],
			async (input) => {
				const db    = resolveDb(input);
				const table = str(input, 'table', true);
				if (!/^[A-Za-z0-9_$]+$/.test(table)) {
					throw new ToolInputError('Table name may only contain letters, digits, _ and $');
				}
				onProgress?.(`Reading table structure: ${table}`);
				const index = await loadSchemaIndex(db.id);
				const entry = index ? schemaIndexService.getTable(index, table) : null;
				evidence.push({kind: 'schema', label: `describe_table ${table}`});
				if (entry) {
					return {
						content: toJson({
							table      : entry.tableName,
							primaryKey : entry.primaryKey,
							foreignKeys: entry.foreignKeys.map((fk) => `${fk.columnName} -> ${fk.referencedTable}.${fk.referencedColumn}`),
							columns    : entry.columns.map((c) => `${c.columnName} ${c.columnType || c.dataType || ''}${c.columnComment ? ` -- ${c.columnComment}` : ''}`.trim()),
						}),
					};
				}
				const result = await databaseService.getTableSchema(db.id, table, databaseName, dbHostOverride);
				return {content: formatRows(result.columns, result.rows, 500)};
			},
		));

		tools.push(tool(
			'query_database',
			'Run one read-only SQL statement (SELECT, SHOW, DESCRIBE or EXPLAIN) against the customer database and get the rows back as tab-separated text. At most 200 rows are returned, so aggregate or filter in SQL when you need totals.',
			{
				sql: {type: 'string', description: 'A single read-only MySQL statement'},
				...dbIdProperty,
			},
			['sql'],
			async (input) => {
				const db  = resolveDb(input);
				const sql = str(input, 'sql', true);
				onProgress?.(`Running query: ${sql.replace(/\s+/g, ' ').slice(0, 60)}...`);
				onDebugLog?.('query', 'Database Query', `Executing query on ${databaseName}`, sql);
				try {
					const result = await databaseService.executeQuery(db.id, sql, databaseName, dbHostOverride);
					evidence.push({kind: 'sql', label: sql, detail: `${result.rowCount} rows`});
					onDebugLog?.('query', 'Database Query', `Query returned ${result.rowCount} rows`);
					return {content: formatRows(result.columns, result.rows, MAX_QUERY_ROWS)};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					evidence.push({kind: 'sql', label: sql, detail: `failed: ${message}`});
					return {content: `Query failed: ${message}${await schemaHint(db.id, message)}`, isError: true};
				}
			},
		));

		tools.push(tool(
			'export_to_csv',
			'Run a read-only SELECT and save the complete result (no row limit) as a CSV file in the user\'s Downloads folder. Use when the user asks for a list, export, extract or overview they will work with outside the chat.',
			{
				sql     : {type: 'string', description: 'A single read-only SELECT statement'},
				filename: {type: 'string', description: 'Descriptive base filename without extension, e.g. "active_customers_brand_x"'},
				...dbIdProperty,
			},
			['sql', 'filename'],
			async (input) => {
				const db       = resolveDb(input);
				const sql      = str(input, 'sql', true);
				const filename = str(input, 'filename', true);
				onProgress?.(`Exporting CSV: ${filename}`);
				try {
					const result = await databaseService.executeQuery(db.id, sql, databaseName, dbHostOverride);
					if (result.rows.length === 0) {
						return {content: 'The query returned no rows, so no file was written.'};
					}
					const file = await exportToCsvFile(filename, result.rows, result.columns);
					evidence.push({kind: 'csv', label: path.basename(file.filePath), detail: `${file.rowCount} rows`});
					return {content: `Saved ${file.rowCount} rows to ${file.filePath}`};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {content: `Export failed: ${message}${await schemaHint(db.id, message)}`, isError: true};
				}
			},
		));
	}

	async function schemaHint(configId: string, errorMessage: string): Promise<string> {
		const index = await loadSchemaIndex(configId);
		if (!index) {
			return '';
		}
		const missingTable = errorMessage.match(/Table '(?:[^'.]+\.)?([^']+)' doesn't exist/i);
		if (missingTable) {
			const suggestions = searchSchemaIndex(index, missingTable[1].replace(/_/g, ' '), 8).map((m) => m.table);
			return suggestions.length > 0 ? `\nTables with similar names: ${suggestions.join(', ')}` : '';
		}
		const missingColumn = errorMessage.match(/Unknown column '(?:([^'.]+)\.)?([^']+)'/i);
		if (missingColumn) {
			const qualifier = missingColumn[1];
			const table     = qualifier ? schemaIndexService.getTable(index, qualifier) : null;
			if (table) {
				return `\nColumns in ${table.tableName}: ${table.columns.map((c) => c.columnName).join(', ')}`;
			}
			return '\nUse describe_table to check the exact column names.';
		}
		return '';
	}

	// ── Code ─────────────────────────────────────────────────────────────────
	if (localRepoUrl) {
		const repo = githubService.localRepo;

		tools.push(tool(
			'search_code',
			'Search the SPY source code (ripgrep) on the chat\'s branch. The pattern is a literal string by default, case-insensitive unless it contains uppercase. Returns matching lines with line numbers, grouped by file.',
			{
				pattern       : {type: 'string', description: 'Text to find, e.g. "function generateEanExcel" or "is_consignment_customer"'},
				regex         : {type: 'boolean', description: 'Treat pattern as a regular expression (Rust regex syntax)'},
				path          : {type: 'string', description: 'Limit to this directory or file, e.g. "applications/Spy/Controller"'},
				glob          : {type: 'string', description: 'Limit to files matching this glob, e.g. "*.php" or "*.{ts,tsx}"'},
				context_lines : {type: 'integer', description: 'Lines of context around each match (0-30, default 0)'},
				case_sensitive: {type: 'boolean'},
				max_matches   : {type: 'integer', description: 'Default 60, max 300'},
			},
			['pattern'],
			async (input) => {
				const pattern = str(input, 'pattern', true);
				onProgress?.(`Searching code: ${pattern.slice(0, 50)}`);
				const result = await repo.search(localRepoUrl, branch, {
					pattern,
					regex        : bool(input, 'regex'),
					caseSensitive: bool(input, 'case_sensitive'),
					path         : str(input, 'path'),
					glob         : str(input, 'glob'),
					contextLines : int(input, 'context_lines', 0, 30),
					maxMatches   : int(input, 'max_matches', 1, 300),
				});
				evidence.push({kind: 'code_search', label: pattern, detail: `${result.matchCount} matches in ${result.files.length} files`});
				if (result.files.length === 0) {
					return {content: `No matches for "${pattern}".`};
				}
				const blocks = result.files.map((file) => {
					let previous = -1;
					const lines  = file.lines.map((l) => {
						const gap = previous !== -1 && l.line > previous + 1 ? '  ...\n' : '';
						previous  = l.line;
						return `${gap}${l.line}${l.isMatch ? ':' : '-'} ${l.text}`;
					});
					return `${file.path}\n${lines.join('\n')}`;
				});
				const note   = result.truncated ? `\n\n[Stopped after ${result.matchCount} matches - narrow with path/glob or a more specific pattern.]` : '';
				return {content: capText(blocks.join('\n\n') + note)};
			},
		));

		tools.push(tool(
			'read_file',
			`Read a source file (or a line range of it) with line numbers. Up to ${MAX_FILE_LINES} lines per call; use start_line/end_line to page through larger files.`,
			{
				path      : {type: 'string', description: 'Path relative to the repository root'},
				start_line: {type: 'integer', description: '1-based first line (default 1)'},
				end_line  : {type: 'integer', description: 'Last line to include'},
			},
			['path'],
			async (input) => {
				const filePath = str(input, 'path', true);
				onProgress?.(`Reading ${filePath}`);
				const content = await repo.readFile(localRepoUrl, branch, filePath);
				const lines   = content.split('\n');
				const start   = int(input, 'start_line', 1, Math.max(1, lines.length)) ?? 1;
				const end     = Math.min(int(input, 'end_line', start, lines.length) ?? lines.length, start + MAX_FILE_LINES - 1);
				evidence.push({kind: 'file', label: filePath, detail: start === 1 && end === lines.length ? undefined : `lines ${start}-${end}`});
				const more = end < lines.length ? `\n\n[File has ${lines.length} lines; showing ${start}-${end}. Continue with start_line=${end + 1}.]` : '';
				return {content: capText(numberLines(lines.slice(start - 1, end).join('\n'), start) + more)};
			},
		));

		tools.push(tool(
			'list_directory',
			'List the files and subdirectories of a repository directory.',
			{path: {type: 'string', description: 'Directory relative to the repository root ("" for the root)'}},
			[],
			async (input) => {
				const dir     = str(input, 'path') ?? '';
				const entries = await repo.listDirectory(localRepoUrl, branch, dir);
				const shown   = entries.slice(0, 500).map((e) => `${e.type === 'dir' ? 'dir ' : 'file'} ${e.path}`);
				return {content: shown.join('\n') + (entries.length > 500 ? `\n[${entries.length - 500} more entries not shown]` : '')};
			},
		));

		tools.push(tool(
			'find_files',
			'Find repository files whose path contains all the given words (case-insensitive), e.g. "controller shopify" or "Topseller".',
			{
				query: {type: 'string'},
				limit: {type: 'integer', description: 'Default 100'},
			},
			['query'],
			async (input) => {
				const query  = str(input, 'query', true);
				const result = await repo.findFiles(localRepoUrl, branch, query, int(input, 'limit', 1, 500) ?? 100);
				evidence.push({kind: 'code_search', label: `find_files "${query}"`, detail: `${result.total} files`});
				if (result.total === 0) {
					return {content: `No file paths contain all of: ${query}`};
				}
				const more = result.total > result.paths.length ? `\n[${result.total - result.paths.length} more]` : '';
				return {content: result.paths.join('\n') + more};
			},
		));

		const formatCommits = (commits: CommitSummary[]): string =>
			commits.map((c) => `${c.sha}  ${c.date}  ${c.author}  ${c.subject}${c.firstRelease ? `  [first release: ${c.firstRelease}]` : ''}`).join('\n');

		tools.push(tool(
			'file_history',
			'Git history of a file or directory: which commits changed it, when, by whom, and the first release branch (YYYY_MM) that shipped each change. With "search", only commits that added or removed that exact text in the path - use it to find when a behaviour was introduced or removed. Defaults to the chat\'s branch.',
			{
				path  : {type: 'string', description: 'File or directory relative to the repository root'},
				search: {type: 'string', description: 'Only commits that added/removed this exact text in the path'},
				since : {type: 'string', description: 'Only commits after this date, e.g. "2026-01-01" or "6 months ago"'},
				branch: {type: 'string', description: 'Branch to read history from (default: the chat\'s branch)'},
				limit : {type: 'integer', description: 'Max commits (default 20, max 100)'},
			},
			['path'],
			async (input) => {
				const filePath = str(input, 'path', true);
				onProgress?.(`Reading history of ${filePath}`);
				const commits = await repo.fileHistory(localRepoUrl, {
					branch: str(input, 'branch') ?? branch,
					path  : filePath,
					search: str(input, 'search'),
					since : str(input, 'since'),
					limit : int(input, 'limit', 1, 100),
				});
				evidence.push({
					kind  : 'history',
					label : `history ${filePath}${input.search ? ` "${input.search}"` : ''}`,
					detail: `${commits.length} commits`,
				});
				return {content: commits.length > 0 ? formatCommits(commits) : 'No matching commits.'};
			},
		));

		tools.push(tool(
			'show_commit',
			'Show a commit: message, changed files and the code diff (optionally only for one path), plus the first release that contains it.',
			{
				commit: {type: 'string', description: 'Commit hash'},
				path  : {type: 'string', description: 'Limit the diff to this file or directory'},
			},
			['commit'],
			async (input) => {
				const commit = str(input, 'commit', true);
				onProgress?.(`Reading commit ${commit}`);
				const text = await repo.showCommit(localRepoUrl, {commit, path: str(input, 'path')});
				evidence.push({kind: 'history', label: `commit ${commit}`});
				return {content: capText(text)};
			},
		));

		tools.push(tool(
			'compare_branches',
			'List the commits that are on one branch but not another - e.g. what changed between two releases ("2026_07" -> "2026_09") - optionally only for one path, with the code diff for that path.',
			{
				from        : {type: 'string', description: 'Older branch, e.g. "2026_07"'},
				to          : {type: 'string', description: 'Newer branch, e.g. "2026_09" (default: the chat\'s branch)'},
				path        : {type: 'string', description: 'Only changes to this file or directory'},
				include_diff: {type: 'boolean', description: 'Include the code diff for the path (requires path)'},
			},
			['from'],
			async (input) => {
				const from = str(input, 'from', true);
				const to   = str(input, 'to') ?? branch;
				if (!to) {
					throw new ToolInputError('Give "to" - this chat has no branch selected');
				}
				onProgress?.(`Comparing ${from} and ${to}`);
				const result = await repo.compareBranches(localRepoUrl, {
					from,
					to,
					path       : str(input, 'path'),
					includeDiff: bool(input, 'include_diff'),
				});
				evidence.push({
					kind  : 'history',
					label : `${from}..${to}${input.path ? ` ${input.path}` : ''}`,
					detail: `${result.totalCommits} commits`,
				});
				const header = `${result.totalCommits} commit(s) on ${to} that are not on ${from}${result.totalCommits > result.commits.length ? ` (showing ${result.commits.length})` : ''}:`;
				return {content: capText([header, formatCommits(result.commits), result.diff ? `\n${result.diff}` : ''].join('\n'))};
			},
		));
	} else if (hasRemote) {
		tools.push(tool(
			'search_code',
			'Search the SPY source code with GitHub code search (default branch only, word-based matching). Returns file paths with matching fragments.',
			{pattern: {type: 'string'}},
			['pattern'],
			async (input) => {
				const pattern = str(input, 'pattern', true);
				const results = await githubService.searchCodeRemote(pattern);
				evidence.push({kind: 'code_search', label: pattern, detail: `${results.length} files (GitHub)`});
				return {content: results.length > 0 ? toJson(results) : `No matches for "${pattern}".`};
			},
		));
		tools.push(tool(
			'read_file',
			'Read a source file from GitHub with line numbers.',
			{
				path      : {type: 'string'},
				start_line: {type: 'integer'},
				end_line  : {type: 'integer'},
			},
			['path'],
			async (input) => {
				const filePath = str(input, 'path', true);
				const lines    = (await githubService.getFileContentRemote(filePath, branch)).split('\n');
				const start    = int(input, 'start_line', 1, Math.max(1, lines.length)) ?? 1;
				const end      = Math.min(int(input, 'end_line', start, lines.length) ?? lines.length, start + MAX_FILE_LINES - 1);
				evidence.push({kind: 'file', label: filePath});
				const more = end < lines.length ? `\n\n[File has ${lines.length} lines; showing ${start}-${end}.]` : '';
				return {content: capText(numberLines(lines.slice(start - 1, end).join('\n'), start) + more)};
			},
		));
		tools.push(tool(
			'list_directory',
			'List a repository directory on GitHub.',
			{path: {type: 'string'}},
			[],
			async (input) => {
				const entries = await githubService.listFilesRemote(str(input, 'path') ?? '', branch);
				return {content: entries.map((e) => `${e.type === 'dir' ? 'dir ' : 'file'} ${e.path}`).join('\n')};
			},
		));
	}

	if (hasSpyCodeAi) {
		tools.push(tool(
			'spy_search_code',
			'Search the pre-built SPY code index by meaning or symbol (classes, methods, entity fields, routes, SQL). Good for discovering where something lives; confirm important details by reading the file when read_file is available.',
			{
				query     : {type: 'string'},
				kind      : {
					type: 'string',
					enum: ['entity_field', 'class', 'method', 'sql_query', 'route', 'relation', 'ts_file', 'view', 'api_endpoint'],
				},
				limit     : {type: 'integer'},
				match_mode: {type: 'string', enum: ['auto', 'semantic', 'symbolic', 'hybrid']},
			},
			['query'],
			async (input) => {
				const query = str(input, 'query', true);
				onProgress?.(`Searching code index: ${query.slice(0, 50)}`);
				const raw = await spyCodeAiMcpService.searchCode({
					query,
					kind      : str(input, 'kind') as SpySearchCodeArgs['kind'],
					limit     : int(input, 'limit', 1, 50),
					match_mode: str(input, 'match_mode') as SpySearchCodeArgs['match_mode'],
				});
				evidence.push({kind: 'mcp', label: query});
				return {content: toJson(raw)};
			},
		));
		tools.push(tool(
			'spy_search_context',
			'Get an overview of how a SPY feature area is implemented (data, logic, API, UI, relationships) from the code index.',
			{
				query: {type: 'string', description: 'Natural-language description of the feature area'},
				limit: {type: 'integer'},
			},
			['query'],
			async (input) => {
				const query = str(input, 'query', true);
				onProgress?.(`Searching code index: ${query.slice(0, 50)}`);
				const raw = await spyCodeAiMcpService.searchContext({query, limit: int(input, 'limit', 1, 50)});
				evidence.push({kind: 'mcp', label: query});
				return {content: toJson(raw)};
			},
		));
	}


	if (hasSentry) {
		const periods = ['24h', '7d', '14d', '30d', '90d'];
		tools.push(tool(
			'search_errors',
			`Search SPY's Sentry for errors (exceptions from PHP and the browser)${systemKey ? `, by default only on this chat's system (${systemKey})` : ''}. Returns issues with how often they occurred in the period and when first/last seen. Use when the user reports an error, a failing page, a crash, or something that "stopped working".`,
			{
				query      : {
					type       : 'string',
					description: 'Optional Sentry search terms, e.g. "Shopify", "url:*s_orders.php*", "level:error", or words from the error message',
				},
				period     : {type: 'string', enum: periods, description: 'Time window (default 7d)'},
				all_systems: {type: 'boolean', description: 'Search across all customer systems instead of this chat\'s system'},
				limit      : {type: 'integer', description: 'Max issues (default 15, max 50)'},
			},
			[],
			async (input) => {
				const allSystems = bool(input, 'all_systems') === true;
				if (!systemKey && !allSystems && !str(input, 'query')) {
					throw new ToolInputError('This chat has no system selected; give a query or set all_systems');
				}
				const period = str(input, 'period') ?? '7d';
				if (!periods.includes(period)) {
					throw new ToolInputError(`period must be one of ${periods.join(', ')}`);
				}
				onProgress?.('Searching Sentry...');
				const issues = await sentryService.searchIssues({
					systemKey: allSystems ? undefined : systemKey,
					query    : str(input, 'query'),
					period,
					limit    : int(input, 'limit', 1, 50) ?? 15,
				});
				evidence.push({
					kind  : 'sentry',
					label : `search_errors${input.query ? ` "${input.query}"` : ''} (${allSystems ? 'all systems' : systemKey}, ${period})`,
					detail: `${issues.length} issues`,
				});
				if (issues.length === 0) {
					return {content: `No errors in Sentry for ${allSystems ? 'any system' : systemKey ?? 'the query'} in the last ${period}.`};
				}
				return {
					content: issues.map((i) => `${i.issue}  ${i.count}×  last ${i.lastSeen ?? '?'}  first ${i.firstSeen ?? '?'}  [${i.project ?? ''}]  ${i.title}\n  ${i.url}`).join('\n'),
				};
			},
		));

		tools.push(tool(
			'get_error_details',
			'Get the details of a Sentry issue: the stack trace (file, line, function), the request URL, tags and breadcrumbs of its latest event on this chat\'s system. Follow up by reading the files in the stack trace.',
			{issue: {type: 'string', description: 'Issue short id (e.g. "SPY-4HE") or Sentry issue URL'}},
			['issue'],
			async (input) => {
				const issue = str(input, 'issue', true);
				onProgress?.(`Reading Sentry issue ${issue}`);
				const text = await sentryService.describeIssue(issue, systemKey);
				evidence.push({kind: 'sentry', label: issue});
				return {content: capText(text)};
			},
		));
	}

	tools.push(tool(
		'search_knowledge',
		'Search the internal SPY knowledge base: feature areas and where their code lives, business terminology and synonyms, and example joins between tables. Use English keywords.',
		{query: {type: 'string'}},
		['query'],
		async (input) => {
			const query = str(input, 'query', true);
			const docs  = await knowledgeService.search(query, 6);
			evidence.push({kind: 'knowledge', label: query, detail: `${docs.length} documents`});
			return {content: docs.length > 0 ? capText(docs.map((d) => d.text).join('\n\n---\n\n')) : 'Nothing found.'};
		},
	));

	tools.push(tool(
		'ask_clarifying_question',
		'Ask the user a question and end your turn. Only for information you cannot look up with the other tools and that would materially change the answer (for example which of two plausible records or features they mean).',
		{
			question       : {type: 'string', description: 'The question, in the user\'s language'},
			options        : {type: 'array', items: {type: 'string'}, description: '2-4 short answers the user can click'},
			allow_free_text: {type: 'boolean', description: 'Allow a typed answer (default true)'},
		},
		['question'],
		async (input) => {
			const question = str(input, 'question', true);
			const options  = Array.isArray(input.options) ? input.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').slice(0, 4) : undefined;
			return {
				content      : 'Question shown to the user.',
				clarification: {
					question,
					options      : options && options.length > 0 ? options : undefined,
					allowFreeText: bool(input, 'allow_free_text') !== false,
				},
			};
		},
	));

	return {
		tools       : tools.map((t) => ({
			definition: t.definition,
			run       : async (input) => {
				try {
					return await t.run(input ?? {});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					onDebugLog?.('error', 'Tool', `${t.definition.name} failed`, message);
					return {content: `Error: ${message}`, isError: true};
				}
			},
		})),
		capabilities: {
			database   : hasDatabase,
			schemaIndex: hasSchemaIndex,
			localCode  : !!localRepoUrl,
			remoteCode : hasRemote,
			spyCodeAi  : hasSpyCodeAi,
			sentry     : hasSentry,
		},
	};
}
