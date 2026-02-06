import {contextBridge, ipcRenderer} from 'electron';
import type {DatabaseConfig} from './types';

contextBridge.exposeInMainWorld('electronAPI', {
	testDatabaseConnection: (config: DatabaseConfig) =>
		ipcRenderer.invoke('test-database-connection', config),

	saveDatabaseConfig: (config: DatabaseConfig) =>
		ipcRenderer.invoke('save-database-config', config),

	getDatabaseConfigs: () =>
		ipcRenderer.invoke('get-database-configs'),

	// Systems directory (customer/system list)
	getSystems: (statuses?: string[]) =>
		ipcRenderer.invoke('get-systems', statuses),

	// Schema index
	getSchemaIndexStatus: (configId: string) =>
		ipcRenderer.invoke('get-schema-index-status', configId),

	generateSchemaIndex: (configId: string, databaseName: string) =>
		ipcRenderer.invoke('generate-schema-index', configId, databaseName),

	onSchemaIndexProgress: (callback: (progress: { stage: string; done: number; total: number }) => void) => {
		const listener = (_event: any, progress: { stage: string; done: number; total: number }) => callback(progress);
		ipcRenderer.on('schema-index-progress', listener);
		return () => {
			ipcRenderer.removeListener('schema-index-progress', listener);
		};
	},

	onSchemaIndexComplete: (callback: (status: any) => void) => {
		const listener = (_event: any, status: any) => callback(status);
		ipcRenderer.on('schema-index-complete', listener);
		return () => {
			ipcRenderer.removeListener('schema-index-complete', listener);
		};
	},

	onSchemaIndexError: (callback: (error: string) => void) => {
		const listener = (_event: any, error: string) => callback(error);
		ipcRenderer.on('schema-index-error', listener);
		return () => {
			ipcRenderer.removeListener('schema-index-error', listener);
		};
	},

	// Attachments
	saveAttachment: (chatId: string, originalName: string, mimeType: string | undefined, dataBase64: string) =>
		ipcRenderer.invoke('save-attachment', chatId, originalName, mimeType, dataBase64),

	getAttachmentDataUrl: (storedPath: string, mimeType: string) =>
		ipcRenderer.invoke('get-attachment-data-url', storedPath, mimeType),

	openAttachment: (storedPath: string) =>
		ipcRenderer.invoke('open-attachment', storedPath),

	sendMessage: (
		chatId: string,
		message: string,
		databases: string[],
		history?: Array<{ role: string; content: string }>,
		chatContext?: { databaseName?: string; dbHost?: string; githubBranch?: string },
		attachments?: any[],
	) =>
		ipcRenderer.invoke('send-message', chatId, message, databases, history, chatContext, attachments),

	startAiStream: (
		chatId: string,
		message: string,
		databases: string[],
		history?: Array<{ role: string; content: string }>,
		chatContext?: { databaseName?: string; dbHost?: string; githubBranch?: string },
		attachments?: any[],
	) =>
		ipcRenderer.invoke('start-ai-stream', chatId, message, databases, history, chatContext, attachments),

	stopAiStream: (streamId: string) =>
		ipcRenderer.invoke('stop-ai-stream', streamId),

	onAiEvent: (callback: (payload: { streamId: string; event: any }) => void) => {
		const listener = (_event: any, payload: { streamId: string; event: any }) => callback(payload);
		ipcRenderer.on('ai-event', listener);
		return () => {
			ipcRenderer.removeListener('ai-event', listener);
		};
	},

	onAiStreamFinished: (callback: (payload: {
		streamId: string;
		result: { shortAnswer: string; detailedAnswer: string; suggestedTitle?: string };
	}) => void) => {
		const listener = (_event: any, payload: {
			streamId: string;
			result: { shortAnswer: string; detailedAnswer: string; suggestedTitle?: string };
		}) => callback(payload);
		ipcRenderer.on('ai-finished', listener);
		return () => {
			ipcRenderer.removeListener('ai-finished', listener);
		};
	},

	onAiStreamError: (callback: (payload: { streamId: string; error: string }) => void) => {
		const listener = (_event: any, payload: { streamId: string; error: string }) => callback(payload);
		ipcRenderer.on('ai-error', listener);
		return () => {
			ipcRenderer.removeListener('ai-error', listener);
		};
	},

	getApiKey: () =>
		ipcRenderer.invoke('get-api-key'),

	saveApiKey: (apiKey: string) =>
		ipcRenderer.invoke('save-api-key', apiKey),

	// Chat management
	getChats: () =>
		ipcRenderer.invoke('get-chats'),

	getChat: (chatId: string) =>
		ipcRenderer.invoke('get-chat', chatId),

	createChat: (title?: string) =>
		ipcRenderer.invoke('create-chat', title),

	updateChat: (chatId: string, messages: any[], update?: any) =>
		ipcRenderer.invoke('update-chat', chatId, messages, update),

	deleteChat: (chatId: string) =>
		ipcRenderer.invoke('delete-chat', chatId),

	setWorkingSummary: (chatId: string, text: string) =>
		ipcRenderer.invoke('set-working-summary', chatId, text),

	clearWorkingSummary: (chatId: string) =>
		ipcRenderer.invoke('clear-working-summary', chatId),

	// Progress updates
	onMessageProgress: (callback: (payload: { chatId: string; streamId: string; status: string } | string) => void) => {
		const listener = (_event: any, payload: any) => callback(payload);
		ipcRenderer.on('message-progress', listener);
		return () => {
			ipcRenderer.removeListener('message-progress', listener);
		};
	},

	// GitHub configuration
	getGitHubConfig: () =>
		ipcRenderer.invoke('get-github-config'),

	saveGitHubConfig: (config: any) =>
		ipcRenderer.invoke('save-github-config', config),

	validateGitHubConfig: () =>
		ipcRenderer.invoke('validate-github-config'),

	getLocalRepoStatus: () =>
		ipcRenderer.invoke('get-local-repo-status'),

	syncLocalRepo: (url: string) =>
		ipcRenderer.invoke('sync-local-repo', url),

	onLocalRepoSyncProgress: (callback: (progress: { stage: string; percent?: number; message?: string }) => void) => {
		const listener = (_event: any, progress: { stage: string; percent?: number; message?: string }) => callback(progress);
		ipcRenderer.on('local-repo-sync-progress', listener);
		return () => {
			ipcRenderer.removeListener('local-repo-sync-progress', listener);
		};
	},

	// Git installation
	checkGitInstalled: () =>
		ipcRenderer.invoke('check-git-installed') as Promise<{ installed: boolean; version: string | null }>,

	installGit: () =>
		ipcRenderer.invoke('install-git') as Promise<{ success: boolean }>,

	// User settings
	getUserName: () =>
		ipcRenderer.invoke('get-user-name'),

	saveUserName: (userName: string) =>
		ipcRenderer.invoke('save-user-name', userName),

	// Window focus
	focusWindow: () =>
		ipcRenderer.invoke('focus-window'),

	// Open external URL in default browser
	openExternalUrl: (url: string) =>
		ipcRenderer.invoke('open-external-url', url),

	// Deep link handler
	onDeepLink: (callback: (url: string) => void) => {
		const listener = (_event: any, url: string) => callback(url);
		ipcRenderer.on('deep-link', listener);
		return () => {
			ipcRenderer.removeListener('deep-link', listener);
		};
	},

	// Debug logging
	onDebugLog: (callback: (log: any) => void) => {
		const listener = (_event: any, log: any) => callback(log);
		ipcRenderer.on('debug-log', listener);
		return () => {
			ipcRenderer.removeListener('debug-log', listener);
		};
	},

	// Debug window
	openDebugWindow: () =>
		ipcRenderer.invoke('open-debug-window'),

	// Auto-updater
	checkForUpdates: () =>
		ipcRenderer.invoke('check-for-updates'),

	downloadUpdate: () =>
		ipcRenderer.invoke('download-update'),

	installUpdate: () =>
		ipcRenderer.invoke('install-update'),

	getAppVersion: () =>
		ipcRenderer.invoke('get-app-version'),

	onUpdateAvailable: (callback: (info: any) => void) => {
		const listener = (_event: any, info: any) => callback(info);
		ipcRenderer.on('update-available', listener);
		return () => {
			ipcRenderer.removeListener('update-available', listener);
		};
	},

	onUpdateDownloadProgress: (callback: (progress: any) => void) => {
		const listener = (_event: any, progress: any) => callback(progress);
		ipcRenderer.on('update-download-progress', listener);
		return () => {
			ipcRenderer.removeListener('update-download-progress', listener);
		};
	},

	onUpdateDownloaded: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on('update-downloaded', listener);
		return () => {
			ipcRenderer.removeListener('update-downloaded', listener);
		};
	},

	onUpdateError: (callback: (error: string) => void) => {
		const listener = (_event: any, error: string) => callback(error);
		ipcRenderer.on('update-error', listener);
		return () => {
			ipcRenderer.removeListener('update-error', listener);
		};
	},
});
