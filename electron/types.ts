export interface DatabaseConfig {
	id: string;
	name: string;
	host: string;
	port: number;
	database: string;
	username: string;
	password: string;
	readOnly: boolean;
}

export interface QueryResult {
	columns: string[];
	rows: Array<Record<string, unknown>>;
	rowCount: number;
}
