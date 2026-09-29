import {app} from 'electron';
import * as fs from 'fs/promises';
import * as mysql from 'mysql2/promise';
import * as path from 'path';
import type {DatabaseConfig, QueryResult} from '../types';
import {SecureStorageService} from './secure-storage-service';

/**
 * DatabaseService - CRITICAL SECURITY: READ-ONLY ENFORCED + ENCRYPTED PASSWORDS
 *
 * This service implements MULTIPLE LAYERS of security to make it PHYSICALLY IMPOSSIBLE to write to databases:
 *
 * Layer 1: Query Whitelist - Only SELECT, SHOW, DESCRIBE, EXPLAIN allowed
 * Layer 2: Keyword Blacklist - Blocks ALL write operations (INSERT, UPDATE, DELETE, etc.)
 * Layer 3: Multiple Statement Protection - Prevents SQL injection via semicolons
 * Layer 4: MySQL Session Read-Only - Forces MySQL to reject any write attempts at the database level
 * Layer 5: Read-Only Transaction - Every query runs inside its own START TRANSACTION READ ONLY ... ROLLBACK
 * Layer 6: Encrypted Password Storage - Database passwords stored using OS-native encryption
 *
 * Even if all application-level checks are bypassed, the MySQL server itself will reject write operations.
 */
export class DatabaseService {
	private readonly configPath: string;
	private readonly queryLogPath: string;
	private readonly secureStorage: SecureStorageService;
	private readonly pools: Map<string, mysql.Pool> = new Map();

	constructor(secureStorage: SecureStorageService) {
		this.configPath    = path.join(app.getPath('userData'), 'database-configs.json');
		this.queryLogPath  = path.join(app.getPath('userData'), 'query-log.txt');
		this.secureStorage = secureStorage;
	}

	private async logQuery(query: string, databaseName: string | undefined, configId: string, success: boolean, error?: string, rowCount?: number): Promise<void> {
		try {
			const timestamp = new Date().toISOString();
			const logEntry  = [
				'═'.repeat(80),
				`[${timestamp}]`,
				`Database: ${databaseName || 'N/A'}`,
				`Config ID: ${configId}`,
				`Status: ${success ? 'SUCCESS' : 'FAILED'}`,
				'',
				'Query:',
				query,
				'',
			];

			if (success && rowCount !== undefined) {
				logEntry.push(`Result: ${rowCount} rows returned`);
			} else if (error) {
				logEntry.push(`Error: ${error}`);
			}

			logEntry.push(''); // Empty line at the end

			await fs.appendFile(this.queryLogPath, logEntry.join('\n'));
		} catch (logError) {
			// Don't throw if logging fails - we don't want to break the actual query
		}
	}

	async testConnection(config: DatabaseConfig): Promise<{ success: boolean; error?: string }> {
		try {
			const connectionOptions: mysql.ConnectionOptions = {
				host    : config.host,
				port    : config.port,
				user    : config.username,
				password: config.password,
			};

			// Only add database if specified
			if (config.database) {
				connectionOptions.database = config.database;
			}

			const connection = await mysql.createConnection(connectionOptions);

			await connection.ping();
			await connection.end();

			return {success: true};
		} catch (error) {
			return {
				success: false,
				error  : error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	async saveConfig(config: DatabaseConfig): Promise<void> {
		const configs       = await this.getConfigs();
		const existingIndex = configs.findIndex((c) => c.id === config.id);

		// Save all sensitive data to encrypted storage
		await this.secureStorage.saveEncrypted(`db-config-${config.id}`, JSON.stringify({
			name    : config.name,
			host    : config.host,
			port    : config.port,
			database: config.database,
			username: config.username,
			password: config.password,
			readOnly: config.readOnly,
		}));

		// Only store ID in plain text
		const safeConfig = {
			id      : config.id,
			name    : '', // Encrypted
			host    : '', // Encrypted
			port    : 0,  // Encrypted
			database: '', // Encrypted
			username: '', // Encrypted
			password: '', // Encrypted
			readOnly: true,
		};

		if (existingIndex >= 0) {
			configs[existingIndex] = safeConfig;
			// Close existing pools so they are recreated with the new config
			await this.closePools(config.id);
		} else {
			configs.push(safeConfig);
		}

		await fs.writeFile(this.configPath, JSON.stringify(configs, null, 2));
	}

	async getConfigs(): Promise<DatabaseConfig[]> {
		try {
			const data    = await fs.readFile(this.configPath, 'utf-8');
			const configs = JSON.parse(data) as DatabaseConfig[];

			// Load full config from encrypted storage
			return await Promise.all(
				configs.map(async (config) => {
					const encryptedData = await this.secureStorage.loadEncrypted(`db-config-${config.id}`);
					if (encryptedData) {
						const fullConfig = JSON.parse(encryptedData);
						return {
							id: config.id,
							...fullConfig,
						};
					}
					// Fallback to empty config if not found
					return config;
				}),
			);
		} catch (error) {
			return [];
		}
	}

	private async getPool(configId: string, databaseName?: string, hostOverride?: string, portOverride?: number): Promise<mysql.Pool> {
		if (!databaseName) {
			throw new Error('Database name must be provided');
		}

		const poolKey  = `${configId}:${hostOverride ?? 'default'}:${portOverride ?? 'default'}:${databaseName}`;
		const existing = this.pools.get(poolKey);
		if (existing) {
			return existing;
		}

		const configs = await this.getConfigs();
		const config  = configs.find((c) => c.id === configId);
		if (!config) {
			throw new Error(`Database config not found: ${configId}`);
		}

		// A pool replaces dropped connections (server wait_timeout, network blips) transparently.
		const pool = mysql.createPool({
			host           : hostOverride ?? config.host,
			port           : portOverride ?? config.port,
			user           : config.username,
			password       : config.password,
			database       : databaseName,
			connectionLimit: 4,
			enableKeepAlive: true,
			dateStrings    : true,
		});
		this.pools.set(poolKey, pool);
		return pool;
	}

	private async closePools(configId: string): Promise<void> {
		for (const [key, pool] of this.pools) {
			if (key.startsWith(`${configId}:`)) {
				this.pools.delete(key);
				await pool.end().catch(() => undefined);
			}
		}
	}

	async executeQuery(configId: string, query: string, databaseName?: string, hostOverride?: string, portOverride?: number): Promise<QueryResult> {
		try {
			// CRITICAL SECURITY: Multiple layers of read-only enforcement
			const normalizedQuery = query.trim().toUpperCase();

			// LAYER 1: Whitelist only read operations
			if (
				!normalizedQuery.startsWith('SELECT') &&
				!normalizedQuery.startsWith('SHOW') &&
				!normalizedQuery.startsWith('DESCRIBE') &&
				!normalizedQuery.startsWith('EXPLAIN')
			) {
				const error = 'SECURITY VIOLATION: Only SELECT, SHOW, DESCRIBE, and EXPLAIN queries are allowed. Write operations are NEVER permitted.';
				await this.logQuery(query, databaseName, configId, false, error);
				throw new Error(error);
			}

			// LAYER 2: Block ALL write keywords (comprehensive list)
			// IMPORTANT: Use keyword-aware matching to avoid false positives on column names like `updated_at`.
			const forbiddenPatterns: Array<{ label: string; pattern: RegExp }> = [
				// Single-keyword writes/DDL
				{label: 'INSERT', pattern: /\bINSERT\b/i},
				{label: 'UPDATE', pattern: /\bUPDATE\b/i},
				{label: 'DELETE', pattern: /\bDELETE\b/i},
				{label: 'DROP', pattern: /\bDROP\b/i},
				{label: 'CREATE', pattern: /\bCREATE\b/i},
				{label: 'ALTER', pattern: /\bALTER\b/i},
				{label: 'TRUNCATE', pattern: /\bTRUNCATE\b/i},
				// REPLACE(str, from, to) is a read-only string function; only the statement form writes.
				{label: 'REPLACE', pattern: /\bREPLACE\b(?!\s*\()/i},
				{label: 'RENAME', pattern: /\bRENAME\b/i},
				{label: 'GRANT', pattern: /\bGRANT\b/i},
				{label: 'REVOKE', pattern: /\bREVOKE\b/i},
				{label: 'LOCK', pattern: /\bLOCK\b/i},
				{label: 'UNLOCK', pattern: /\bUNLOCK\b/i},
				{label: 'CALL', pattern: /\bCALL\b/i},
				{label: 'EXECUTE', pattern: /\bEXECUTE\b/i},

				// File/loader related (data exfiltration / writes)
				{label: 'INTO OUTFILE', pattern: /\bINTO\s+OUTFILE\b/i},
				{label: 'INTO DUMPFILE', pattern: /\bINTO\s+DUMPFILE\b/i},
				{label: 'LOAD DATA', pattern: /\bLOAD\s+DATA\b/i},
				{label: 'LOAD XML', pattern: /\bLOAD\s+XML\b/i},
			];

			for (const {label, pattern} of forbiddenPatterns) {
				if (pattern.test(query)) {
					const error = `SECURITY VIOLATION: Query contains forbidden keyword: ${label}. Write operations are NEVER permitted.`;
					await this.logQuery(query, databaseName, configId, false, error);
					throw new Error(error);
				}
			}

			// LAYER 3: Block semicolons (prevents multiple statements if somehow bypassed)
			if (query.includes(';') && !query.trim().endsWith(';')) {
				const error = 'SECURITY VIOLATION: Multiple statements detected. Only single read queries are allowed.';
				await this.logQuery(query, databaseName, configId, false, error);
				throw new Error(error);
			}

			// LAYER 4 + 5: every query runs in its own read-only session and transaction, so
			// MySQL itself rejects writes and each query sees current data (a long-lived
			// transaction would pin an old snapshot).
			const pool             = await this.getPool(configId, databaseName, hostOverride, portOverride);
			const connection       = await pool.getConnection();
			const QUERY_TIMEOUT_MS = 60_000;
			let healthy            = true;
			let rows: any;
			let fields: any;
			try {
				try {
					await connection.query('SET SESSION TRANSACTION READ ONLY');
					await connection.query('START TRANSACTION READ ONLY');
				} catch {
					healthy = false;
					throw new Error('SECURITY: Failed to enforce read-only mode on database connection');
				}
				try {
					[rows, fields] = await connection.query({sql: query, timeout: QUERY_TIMEOUT_MS});
				} catch (queryError) {
					const msg = queryError instanceof Error ? queryError.message : String(queryError);
					// Provide a clear timeout message so Claude knows to simplify the query
					if (msg.includes('timeout') || msg.includes('TIMEOUT') || msg.includes('ETIMEDOUT')) {
						const timeoutError = `QUERY TIMEOUT: Query exceeded ${QUERY_TIMEOUT_MS / 1000}s limit and was cancelled. Simplify the query: use smaller LIMIT, fewer JOINs, or add WHERE conditions to narrow the data.`;
						await this.logQuery(query, databaseName, configId, false, timeoutError);
						throw new Error(timeoutError);
					}
					throw queryError;
				}
			} finally {
				if (healthy) {
					await connection.query('ROLLBACK').catch(() => {
						healthy = false;
					});
				}
				if (healthy) {
					connection.release();
				} else {
					connection.destroy();
				}
			}

			const result = {
				columns : fields?.map((f: any) => f.name) || [],
				rows    : rows as Array<Record<string, unknown>>,
				rowCount: Array.isArray(rows) ? rows.length : 0,
			};

			// Log successful query
			await this.logQuery(query, databaseName, configId, true, undefined, result.rowCount);

			return result;
		} catch (error) {
			// If error wasn't already logged (non-security errors), log it now
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			if (!errorMessage.includes('SECURITY VIOLATION') && !errorMessage.includes('QUERY TIMEOUT')) {
				await this.logQuery(query, databaseName, configId, false, errorMessage);
			}
			throw error;
		}
	}

	async getTableSchema(configId: string, tableName: string, databaseName?: string, hostOverride?: string, portOverride?: number): Promise<QueryResult> {
		if (!/^[A-Za-z0-9_$]+$/.test(tableName)) {
			throw new Error(`Invalid table name: ${tableName}`);
		}
		return await this.executeQuery(configId, `DESCRIBE \`${tableName}\``, databaseName, hostOverride, portOverride);
	}

	async listTables(configId: string, databaseName?: string, hostOverride?: string, portOverride?: number): Promise<string[]> {
		const result = await this.executeQuery(configId, 'SHOW TABLES', databaseName, hostOverride, portOverride);
		return result.rows.map((row) => Object.values(row)[0] as string);
	}
}
