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

export interface Message {
	role: 'user' | 'assistant';
	content: string;
	detailedContent?: string;
	timestamp: Date;
	attachments?: AttachmentMeta[];
}

export interface AttachmentMeta {
	id: string;
	originalName: string;
	mimeType: string;
	sizeBytes: number;
	storedPath: string;
}

export interface Chat {
	id: string;
	title: string;
	messages: Array<{
		role: 'user' | 'assistant';
		content: string;
		detailedContent?: string;
		timestamp: string;
		attachments?: AttachmentMeta[];
	}>;
	databaseName?: string;
	branch?: string;
	workingSummary?: {
		text: string;
		updatedAt: string;
	};
	createdAt: string;
	updatedAt: string;
}

export interface GitHubConfig {
	token: string;
	owner: string;
	repo: string;
	branch: string;
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
	source?: 'information_schema' | 'describe_fallback';
}

declare global {
	interface Window {
		electronAPI: {
			testDatabaseConnection: (config: DatabaseConfig) => Promise<{ success: boolean; error?: string }>;
			saveDatabaseConfig: (config: DatabaseConfig) => Promise<void>;
			getDatabaseConfigs: () => Promise<DatabaseConfig[]>;
			deleteDatabaseConfig: (id: string) => Promise<void>;
			getSchemaIndexStatus: (configId: string) => Promise<SchemaIndexStatus>;
			generateSchemaIndex: (configId: string, databaseName: string) => Promise<SchemaIndexStatus>;
			onSchemaIndexProgress: (callback: (progress: SchemaIndexProgress) => void) => () => void;
			onSchemaIndexComplete: (callback: (status: SchemaIndexStatus) => void) => () => void;
			onSchemaIndexError: (callback: (error: string) => void) => () => void;
			saveAttachment: (chatId: string, originalName: string, mimeType: string | undefined, dataBase64: string) => Promise<AttachmentMeta>;
			getAttachmentDataUrl: (storedPath: string, mimeType: string) => Promise<string>;
			openAttachment: (storedPath: string) => Promise<{ success: boolean; error?: string }>;
			sendMessage: (chatId: string, message: string, databases: string[], history?: Array<{
				role: string;
				content: string
			}>, databaseName?: string, attachments?: AttachmentMeta[]) => Promise<{ shortAnswer: string; detailedAnswer: string }>;
			getApiKey: () => Promise<string | null>;
			saveApiKey: (apiKey: string) => Promise<void>;
			getChats: () => Promise<Chat[]>;
			getChat: (chatId: string) => Promise<Chat | null>;
			createChat: (title?: string) => Promise<Chat>;
			updateChat: (chatId: string, messages: Array<{
				role: 'user' | 'assistant';
				content: string;
				detailedContent?: string;
				timestamp: string
			}>, title?: string, databaseName?: string, branch?: string) => Promise<void>;
			deleteChat: (chatId: string) => Promise<void>;
			setWorkingSummary: (chatId: string, text: string) => Promise<void>;
			clearWorkingSummary: (chatId: string) => Promise<void>;
			onMessageProgress: (callback: (status: string) => void) => () => void;
			getGitHubConfig: () => Promise<GitHubConfig | null>;
			saveGitHubConfig: (config: GitHubConfig) => Promise<void>;
			validateGitHubConfig: () => Promise<{ valid: boolean; error?: string; user?: string }>;
			getUserName: () => Promise<string | null>;
			saveUserName: (userName: string) => Promise<void>;
			openDebugWindow: () => Promise<void>;
			focusWindow: () => Promise<void>;
			onDeepLink: (callback: (url: string) => void) => () => void;
			onDebugLog: (callback: (log: {
				timestamp: string;
				type: 'query' | 'tool' | 'api' | 'error' | 'info';
				category: string;
				message: string;
				details?: string;
			}) => void) => () => void;
			checkForUpdates: () => Promise<{ available: boolean; version?: string; currentVersion?: string; error?: string }>;
			downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
			installUpdate: () => void;
			getAppVersion: () => Promise<string>;
			onUpdateAvailable: (callback: (info: any) => void) => () => void;
			onUpdateDownloadProgress: (callback: (progress: any) => void) => () => void;
			onUpdateDownloaded: (callback: () => void) => () => void;
			onUpdateError: (callback: (error: string) => void) => () => void;
		};
	}
}
