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
	timestamp: Date;
}

export interface Chat {
	id: string;
	title: string;
	messages: Array<{
		role: 'user' | 'assistant';
		content: string;
		timestamp: string;
	}>;
	databaseName?: string;
	branch?: string;
	createdAt: string;
	updatedAt: string;
}

export interface GitHubConfig {
	token: string;
	owner: string;
	repo: string;
	branch: string;
}

declare global {
	interface Window {
		electronAPI: {
			testDatabaseConnection: (config: DatabaseConfig) => Promise<{ success: boolean; error?: string }>;
			saveDatabaseConfig: (config: DatabaseConfig) => Promise<void>;
			getDatabaseConfigs: () => Promise<DatabaseConfig[]>;
			deleteDatabaseConfig: (id: string) => Promise<void>;
			sendMessage: (message: string, databases: string[], history?: Array<{
				role: string;
				content: string
			}>, databaseName?: string) => Promise<string>;
			getApiKey: () => Promise<string | null>;
			saveApiKey: (apiKey: string) => Promise<void>;
			generateTldr: (messageContent: string) => Promise<string>;
			getChats: () => Promise<Chat[]>;
			getChat: (chatId: string) => Promise<Chat | null>;
			createChat: (title?: string) => Promise<Chat>;
			updateChat: (chatId: string, messages: Array<{
				role: 'user' | 'assistant';
				content: string;
				timestamp: string
			}>, title?: string, databaseName?: string, branch?: string) => Promise<void>;
			deleteChat: (chatId: string) => Promise<void>;
			onMessageProgress: (callback: (status: string) => void) => () => void;
			getGitHubConfig: () => Promise<GitHubConfig | null>;
			saveGitHubConfig: (config: GitHubConfig) => Promise<void>;
			validateGitHubConfig: () => Promise<{ valid: boolean; error?: string; user?: string }>;
			getUserName: () => Promise<string | null>;
			saveUserName: (userName: string) => Promise<void>;
			getAutoTldr: () => Promise<boolean>;
			saveAutoTldr: (autoTldr: boolean) => Promise<void>;
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
