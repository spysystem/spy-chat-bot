import * as mysql from 'mysql2/promise';
import * as fs from 'fs/promises';
import * as path from 'path';
import {app} from 'electron';
import type {DatabaseConfig, QueryResult} from '../types';

/**
 * DatabaseService - CRITICAL SECURITY: READ-ONLY ENFORCED
 *
 * This service implements MULTIPLE LAYERS of security to make it PHYSICALLY IMPOSSIBLE to write to databases:
 *
 * Layer 1: Query Whitelist - Only SELECT, SHOW, DESCRIBE, EXPLAIN allowed
 * Layer 2: Keyword Blacklist - Blocks ALL write operations (INSERT, UPDATE, DELETE, etc.)
 * Layer 3: Multiple Statement Protection - Prevents SQL injection via semicolons
 * Layer 4: MySQL Session Read-Only - Forces MySQL to reject any write attempts at the database level
 * Layer 5: Read-Only Transaction - Starts all connections in read-only transaction mode
 *
 * Even if all application-level checks are bypassed, the MySQL server itself will reject write operations.
 */
export class DatabaseService {
	private readonly configPath: string;
	private readonly queryLogPath: string;
	private connections: Map<string, mysql.Connection> = new Map();

	constructor() {
		this.configPath = path.join(app.getPath('userData'), 'database-configs.json');
		this.queryLogPath = path.join(app.getPath('userData'), 'query-log.txt');
	}

	private async logQuery(query: string, databaseName: string | undefined, configId: string, success: boolean, error?: string, rowCount?: number): Promise<void> {
		try {
			const timestamp = new Date().toISOString();
			const logEntry = [
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

		if (existingIndex >= 0) {
			configs[existingIndex] = config;
			// Close existing connection so it will be recreated with new config
			const connection       = this.connections.get(config.id);
			if (connection) {
				await connection.end();
				this.connections.delete(config.id);
			}
		} else {
			configs.push(config);
		}

		await fs.writeFile(this.configPath, JSON.stringify(configs, null, 2));
	}

	async getConfigs(): Promise<DatabaseConfig[]> {
		try {
			const data = await fs.readFile(this.configPath, 'utf-8');
			return JSON.parse(data);
		} catch (error) {
			return [];
		}
	}

	async deleteConfig(id: string): Promise<void> {
		const configs  = await this.getConfigs();
		const filtered = configs.filter((c) => c.id !== id);
		await fs.writeFile(this.configPath, JSON.stringify(filtered, null, 2));

		// Close connection if exists
		const connection = this.connections.get(id);
		if (connection) {
			await connection.end();
			this.connections.delete(id);
		}
	}

	async getConnection(configId: string, databaseName?: string): Promise<mysql.Connection> {
		// Use provided database name, or throw error if none provided
		if (!databaseName) {
			throw new Error('Database name must be provided');
		}

		// Create unique key for connection cache
		const connectionKey = `${configId}:${databaseName}`;

		// Return existing connection if available
		if (this.connections.has(connectionKey)) {
			return this.connections.get(connectionKey)!;
		}

		// Get config and create new connection
		const configs = await this.getConfigs();
		const config  = configs.find((c) => c.id === configId);

		if (!config) {
			throw new Error(`Database config not found: ${configId}`);
		}

		// CRITICAL SECURITY: Create connection with read-only protections
		const connection = await mysql.createConnection({
			host    : config.host,
			port    : config.port,
			user    : config.username,
			password: config.password,
			database: databaseName,
		});

		// CRITICAL SECURITY: Force MySQL session to read-only mode
		// This makes it PHYSICALLY IMPOSSIBLE to write to the database at the MySQL level
		try {
			await connection.query('SET SESSION TRANSACTION READ ONLY');
			// Start a read-only transaction
			await connection.query('START TRANSACTION READ ONLY');
		} catch (error) {
			// If we can't set read-only mode, close connection and fail
			await connection.end();
			throw new Error('SECURITY: Failed to enforce read-only mode on database connection');
		}

		this.connections.set(connectionKey, connection);
		return connection;
	}

	async executeQuery(configId: string, query: string, databaseName?: string): Promise<QueryResult> {
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
			const forbiddenKeywords = [
				'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'REPLACE',
				'RENAME', 'GRANT', 'REVOKE', 'LOCK', 'UNLOCK', 'CALL', 'EXECUTE', 'LOAD',
				'INTO OUTFILE', 'INTO DUMPFILE', 'LOAD DATA', 'LOAD XML',
			];

			for (const keyword of forbiddenKeywords) {
				if (normalizedQuery.includes(keyword)) {
					const error = `SECURITY VIOLATION: Query contains forbidden keyword: ${keyword}. Write operations are NEVER permitted.`;
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

			// LAYER 4: MySQL enforced read-only transaction (set in getConnection)
			const connection     = await this.getConnection(configId, databaseName);
			const [rows, fields] = await connection.query(query);

			const result = {
				columns : fields?.map((f) => f.name) || [],
				rows    : rows as Array<Record<string, unknown>>,
				rowCount: Array.isArray(rows) ? rows.length : 0,
			};

			// Log successful query
			await this.logQuery(query, databaseName, configId, true, undefined, result.rowCount);

			return result;
		} catch (error) {
			// If error wasn't already logged (non-security errors), log it now
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			if (!errorMessage.includes('SECURITY VIOLATION')) {
				await this.logQuery(query, databaseName, configId, false, errorMessage);
			}
			throw error;
		}
	}

	async getTableSchema(configId: string, tableName: string, databaseName?: string): Promise<QueryResult> {
		return await this.executeQuery(configId, `DESCRIBE ${tableName}`, databaseName);
	}

	async listTables(configId: string, databaseName?: string): Promise<string[]> {
		const result = await this.executeQuery(configId, 'SHOW TABLES', databaseName);
		return result.rows.map((row) => Object.values(row)[0] as string);
	}
}
