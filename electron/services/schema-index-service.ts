import {app} from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import {promisify} from 'util';
import type {DatabaseService} from './database-service';

const gzipAsync   = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

export type SchemaIndexSource = 'information_schema' | 'describe_fallback';

export interface SchemaIndexColumn {
	tableName: string;
	columnName: string;
	dataType?: string;
	columnType?: string;
	ordinalPosition?: number;
	isNullable?: boolean;
	columnComment?: string;
}

export interface SchemaIndexForeignKey {
	columnName: string;
	referencedTable: string;
	referencedColumn: string;
}

export interface SchemaIndexTable {
	tableName: string;
	tableComment?: string;
	tags?: string[];
	columns: SchemaIndexColumn[];
	primaryKey: string[];
	foreignKeys: SchemaIndexForeignKey[];
}

export interface SchemaIndexFileV1 {
	version: 1;
	generatedAtIso: string;
	dbHost?: string;
	configId: string;
	/**
	 * Database name used to GENERATE this schema snapshot.
	 * The resulting index is intended to be reused across databases with the same schema.
	 */
	sampleDatabaseName: string;
	source: SchemaIndexSource;
	tables: SchemaIndexTable[];
}

export interface SchemaIndexProgress {
	stage: string;
	done: number;
	total: number;
}

export interface SchemaIndexStatus {
	exists: boolean;
	filePath: string;
	generatedAtIso?: string;
	tableCount?: number;
	source?: SchemaIndexSource;
}

function sanitizeForFilename(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function assertSafeIdentifier(value: string, label: string): void {
	// Defensive validation: database names are user-entered in the UI.
	// We only accept common MySQL identifier characters to avoid injection into our internal schema queries.
	if (!/^[a-zA-Z0-9_]+$/.test(value)) {
		throw new Error(`${label} contains unsupported characters. Use only letters, numbers, and underscore.`);
	}
}

function normalizeNeedle(value: string): string {
	return value.trim().toLowerCase();
}

export class SchemaIndexService {
	private readonly baseDir: string;
	private readonly memoryCache: Map<string, { index: SchemaIndexFileV1; loadedAtMs: number }> = new Map();

	constructor() {
		this.baseDir = path.join(app.getPath('userData'), 'schema-index');
	}

	private buildKey(configId: string): string {
		return configId;
	}

	private buildFilePath(configId: string): string {
		const safeConfigId = sanitizeForFilename(configId);
		return path.join(this.baseDir, safeConfigId, `schema.json.gz`);
	}

	private buildTags(tableName: string, tableComment?: string): string[] {
		const tokens: string[] = [];
		const nameParts        = tableName.split(/[_\-]+/g);
		for (const part of nameParts) {
			const p = part.trim().toLowerCase();
			if (p.length >= 3) {
				tokens.push(p);
			}
		}
		if (tableComment) {
			const commentParts = tableComment.split(/[^a-zA-Z0-9]+/g);
			for (const part of commentParts) {
				const p = part.trim().toLowerCase();
				if (p.length >= 4) {
					tokens.push(p);
				}
			}
		}
		// Keep unique + stable order
		return Array.from(new Set(tokens)).slice(0, 40);
	}

	async getStatus(configId: string): Promise<SchemaIndexStatus> {
		const filePath = this.buildFilePath(configId);
		try {
			const buf      = await fs.readFile(filePath);
			const unzipped = await gunzipAsync(buf);
			const parsed   = JSON.parse(unzipped.toString('utf-8')) as SchemaIndexFileV1;
			return {
				exists        : true,
				filePath,
				generatedAtIso: parsed.generatedAtIso,
				tableCount    : parsed.tables.length,
				source        : parsed.source,
			};
		} catch (error) {
			return {exists: false, filePath};
		}
	}

	async loadIndex(configId: string): Promise<SchemaIndexFileV1 | null> {
		const key    = this.buildKey(configId);
		const cached = this.memoryCache.get(key);
		if (cached) {
			return cached.index;
		}

		const filePath = this.buildFilePath(configId);
		try {
			const buf      = await fs.readFile(filePath);
			const unzipped = await gunzipAsync(buf);
			const parsed   = JSON.parse(unzipped.toString('utf-8')) as SchemaIndexFileV1;
			if (parsed.version !== 1) {
				return null;
			}
			this.memoryCache.set(key, {index: parsed, loadedAtMs: Date.now()});
			return parsed;
		} catch {
			return null;
		}
	}

	async generateIndex(
		configId: string,
		sampleDatabaseName: string,
		databaseService: DatabaseService,
		onProgress?: (progress: SchemaIndexProgress) => void,
	): Promise<SchemaIndexStatus> {
		assertSafeIdentifier(sampleDatabaseName, 'Database name');

		const filePath = this.buildFilePath(configId);
		await fs.mkdir(path.dirname(filePath), {recursive: true});

		// Use multiple steps so the Settings progress bar visibly moves.
		const infoSchemaStepsTotal = 5;
		onProgress?.({stage: 'Preparing schema index generation...', done: 0, total: infoSchemaStepsTotal});

		// Prefer information_schema. If access is denied, we fall back to SHOW TABLES + DESCRIBE.
		let index: SchemaIndexFileV1 | null = null;

		try {
			index = await this.generateFromInformationSchema(configId, sampleDatabaseName, databaseService, onProgress);
		} catch (error) {
			// Non-fatal: we'll fall back to DESCRIBE-based indexing below.
		}

		if (!index) {
			// Fallback will report per-table progress from generateFromDescribeFallback().
			onProgress?.({stage: 'Falling back to DESCRIBE-based indexing...', done: 0, total: 1});
			index = await this.generateFromDescribeFallback(configId, sampleDatabaseName, databaseService, onProgress);
			// Note: We intentionally do not surface lastInfoSchemaError here via return type to keep UI simple.
			// The caller can log it to the debug window if desired.
		}

		onProgress?.({stage: 'Saving schema index to disk...', done: 4, total: infoSchemaStepsTotal});
		const json = JSON.stringify(index);
		const gz   = await gzipAsync(Buffer.from(json, 'utf-8'));
		await fs.writeFile(filePath, gz);

		// Update memory cache.
		this.memoryCache.set(this.buildKey(configId), {index, loadedAtMs: Date.now()});

		onProgress?.({stage: 'Schema index ready', done: infoSchemaStepsTotal, total: infoSchemaStepsTotal});
		return {
			exists        : true,
			filePath,
			generatedAtIso: index.generatedAtIso,
			tableCount    : index.tables.length,
			source        : index.source,
		};
	}

	private async generateFromInformationSchema(
		configId: string,
		databaseName: string,
		databaseService: DatabaseService,
		onProgress?: (progress: SchemaIndexProgress) => void,
	): Promise<SchemaIndexFileV1> {
		// Keep these aligned with generateIndex() infoSchemaStepsTotal (5).
		const stepsTotal = 5;
		onProgress?.({stage: 'Reading tables from information_schema...', done: 1, total: stepsTotal});

		const tablesResult = await databaseService.executeQuery(
			configId,
			`SELECT t.table_name    AS tableName,
                    t.table_comment AS tableComment
             FROM information_schema.tables t
             WHERE t.table_schema = '${databaseName}'
                       && t.table_type = 'BASE TABLE'
             ORDER BY t.table_name`,
			databaseName,
		);

		const tableRows = tablesResult.rows
			.map((r) => ({
				tableName   : String((r as any).tableName ?? ''),
				tableComment: (r as any).tableComment ? String((r as any).tableComment) : undefined,
			}))
			.filter((t) => t.tableName !== '');

		onProgress?.({stage: 'Reading columns from information_schema...', done: 2, total: stepsTotal});

		const columnsResult = await databaseService.executeQuery(
			configId,
			`SELECT c.table_name       AS tableName,
                    c.column_name      AS columnName,
                    c.data_type        AS dataType,
                    c.column_type      AS columnType,
                    c.ordinal_position AS ordinalPosition,
                    c.is_nullable      AS isNullable,
                    c.column_comment   AS columnComment
             FROM information_schema.columns c
             WHERE c.table_schema = '${databaseName}'
             ORDER BY c.table_name, c.ordinal_position`,
			databaseName,
		);

		onProgress?.({stage: 'Reading keys from information_schema...', done: 3, total: stepsTotal});

		const keysResult = await databaseService.executeQuery(
			configId,
			`SELECT kcu.table_name             AS tableName,
                    kcu.column_name            AS columnName,
                    tc.constraint_type         AS constraintType,
                    kcu.referenced_table_name  AS referencedTable,
                    kcu.referenced_column_name AS referencedColumn
             FROM information_schema.key_column_usage kcu
                      JOIN information_schema.table_constraints tc
                           ON tc.constraint_schema = kcu.constraint_schema
                               && tc.table_name = kcu.table_name
                               && tc.constraint_name = kcu.constraint_name
             WHERE kcu.table_schema = '${databaseName}'
                       && tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
             ORDER BY kcu.table_name, kcu.ordinal_position`,
			databaseName,
		);

		// Build table map.
		const tablesByName: Map<string, SchemaIndexTable> = new Map();
		for (const row of tableRows) {
			const tags = this.buildTags(row.tableName, row.tableComment);
			tablesByName.set(row.tableName, {
				tableName   : row.tableName,
				tableComment: row.tableComment && row.tableComment.trim() !== '' ? row.tableComment : undefined,
				tags,
				columns     : [],
				primaryKey  : [],
				foreignKeys : [],
			});
		}

		for (const row of columnsResult.rows) {
			const tableName  = String((row as any).tableName ?? '');
			const columnName = String((row as any).columnName ?? '');
			if (!tableName || !columnName) {
				continue;
			}
			const table = tablesByName.get(tableName) ?? {tableName, columns: [], primaryKey: [], foreignKeys: []};
			tablesByName.set(tableName, table);

			const isNullableRaw = String((row as any).isNullable ?? '').toUpperCase();
			table.columns.push({
				tableName,
				columnName,
				dataType       : (row as any).dataType ? String((row as any).dataType) : undefined,
				columnType     : (row as any).columnType ? String((row as any).columnType) : undefined,
				ordinalPosition: typeof (row as any).ordinalPosition === 'number' ? (row as any).ordinalPosition : undefined,
				isNullable     : isNullableRaw === 'YES' ? true : isNullableRaw === 'NO' ? false : undefined,
				columnComment  : (row as any).columnComment ? String((row as any).columnComment) : undefined,
			});
		}

		for (const row of keysResult.rows) {
			const tableName      = String((row as any).tableName ?? '');
			const columnName     = String((row as any).columnName ?? '');
			const constraintType = String((row as any).constraintType ?? '');
			if (!tableName || !columnName || !constraintType) {
				continue;
			}
			const table = tablesByName.get(tableName) ?? {tableName, columns: [], primaryKey: [], foreignKeys: []};
			tablesByName.set(tableName, table);

			if (constraintType === 'PRIMARY KEY') {
				table.primaryKey.push(columnName);
				continue;
			}

			if (constraintType === 'FOREIGN KEY') {
				const referencedTable  = String((row as any).referencedTable ?? '');
				const referencedColumn = String((row as any).referencedColumn ?? '');
				if (referencedTable && referencedColumn) {
					table.foreignKeys.push({columnName, referencedTable, referencedColumn});
				}
			}
		}

		// Keep stable ordering for deterministic output.
		const tables: SchemaIndexTable[] = Array.from(tablesByName.values())
			.sort((a, b) => a.tableName.localeCompare(b.tableName))
			.map((t) => ({
				...t,
				columns    : t.columns.slice().sort((a, b) => (a.ordinalPosition ?? 0) - (b.ordinalPosition ?? 0)),
				primaryKey : Array.from(new Set(t.primaryKey)),
				foreignKeys: t.foreignKeys.slice(),
			}));

		onProgress?.({stage: 'Assembling schema index...', done: 4, total: 5});

		return {
			version           : 1,
			generatedAtIso    : new Date().toISOString(),
			configId,
			sampleDatabaseName: databaseName,
			source            : 'information_schema',
			tables,
		};
	}

	private async generateFromDescribeFallback(
		configId: string,
		databaseName: string,
		databaseService: DatabaseService,
		onProgress?: (progress: SchemaIndexProgress) => void,
	): Promise<SchemaIndexFileV1> {
		onProgress?.({stage: 'Listing tables...', done: 0, total: 1});

		const tableNames = await databaseService.listTables(configId, databaseName);
		const total      = tableNames.length;

		const tables: SchemaIndexTable[] = [];

		let done = 0;
		for (const tableName of tableNames) {
			done++;
			onProgress?.({stage: `Describing table: ${tableName}`, done, total});
			const schema = await databaseService.getTableSchema(configId, tableName, databaseName);

			const columns: SchemaIndexColumn[] = [];
			for (let index = 0; index < schema.rows.length; index++) {
				const row        = schema.rows[index];
				const columnName = String((row as any).Field ?? '');
				if (!columnName) {
					continue;
				}
				const columnType    = (row as any).Type ? String((row as any).Type) : undefined;
				const isNullableRaw = (row as any).Null ? String((row as any).Null).toUpperCase() : '';
				const isNullable    = isNullableRaw === 'YES' ? true : isNullableRaw === 'NO' ? false : undefined;
				columns.push({
					tableName,
					columnName,
					columnType,
					ordinalPosition: index + 1,
					isNullable,
				});
			}

			const primaryKey = schema.rows
				.map((row) => {
					const key = String((row as any).Key ?? '');
					return key === 'PRI' ? String((row as any).Field ?? '') : '';
				})
				.filter((c) => c !== '');

			tables.push({
				tableName,
				columns,
				primaryKey : Array.from(new Set(primaryKey)),
				foreignKeys: [],
			});
		}

		return {
			version           : 1,
			generatedAtIso    : new Date().toISOString(),
			configId,
			sampleDatabaseName: databaseName,
			source            : 'describe_fallback',
			tables            : tables.sort((a, b) => a.tableName.localeCompare(b.tableName)),
		};
	}

	searchSchema(index: SchemaIndexFileV1, query: string, limitTables: number = 10): Array<{
		tableName: string;
		score: number;
		matchingColumns: string[];
	}> {
		const needle = normalizeNeedle(query);
		if (!needle) {
			return [];
		}

		const results: Array<{ tableName: string; score: number; matchingColumns: string[] }> = [];

		for (const table of index.tables) {
			const tableNameLower = table.tableName.toLowerCase();
			let score            = 0;

			if (tableNameLower === needle) {
				score += 100;
			} else if (tableNameLower.startsWith(needle)) {
				score += 50;
			} else if (tableNameLower.includes(needle)) {
				score += 20;
			}

			const matchingColumns: string[] = [];
			for (const col of table.columns) {
				const colLower = col.columnName.toLowerCase();
				if (colLower === needle) {
					score += 40;
					matchingColumns.push(col.columnName);
				} else if (colLower.startsWith(needle)) {
					score += 15;
					matchingColumns.push(col.columnName);
				} else if (colLower.includes(needle)) {
					score += 5;
					matchingColumns.push(col.columnName);
				}

				// Column comments help map business terms to technical fields.
				if (col.columnComment) {
					const cc = col.columnComment.toLowerCase();
					if (cc.includes(needle)) {
						score += 2;
					}
				}
			}

			// Table comment / tags boost semantic-ish matches without embeddings.
			if (table.tableComment) {
				const tc = table.tableComment.toLowerCase();
				if (tc.includes(needle)) {
					score += 3;
				}
			}
			if (table.tags && table.tags.some((t) => t.includes(needle))) {
				score += 4;
			}

			if (score > 0) {
				results.push({
					tableName      : table.tableName,
					score,
					matchingColumns: matchingColumns.slice(0, 20),
				});
			}
		}

		return results
			.sort((a, b) => b.score - a.score || a.tableName.localeCompare(b.tableName))
			.slice(0, limitTables);
	}

	getTable(index: SchemaIndexFileV1, tableName: string): SchemaIndexTable | null {
		const needle = tableName.trim();
		if (!needle) {
			return null;
		}
		const exact = index.tables.find((t) => t.tableName === needle);
		if (exact) {
			return exact;
		}
		const lower = needle.toLowerCase();
		return index.tables.find((t) => t.tableName.toLowerCase() === lower) ?? null;
	}
}

