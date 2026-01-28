import {contextBridge, ipcRenderer} from 'electron';
import type {DatabaseConfig} from './types';

contextBridge.exposeInMainWorld('electronAPI', {
	testDatabaseConnection: (config: DatabaseConfig) =>
		ipcRenderer.invoke('test-database-connection', config),

	saveDatabaseConfig: (config: DatabaseConfig) =>
		ipcRenderer.invoke('save-database-config', config),

	getDatabaseConfigs: () =>
		ipcRenderer.invoke('get-database-configs'),

	deleteDatabaseConfig: (id: string) =>
		ipcRenderer.invoke('delete-database-config', id),

	sendMessage: (message: string, databases: string[], history?: Array<{ role: string; content: string }>, databaseName?: string) =>
		ipcRenderer.invoke('send-message', message, databases, history, databaseName),

	getApiKey: () =>
		ipcRenderer.invoke('get-api-key'),

	saveApiKey: (apiKey: string) =>
		ipcRenderer.invoke('save-api-key', apiKey),

	generateTldr: (messageContent: string) =>
		ipcRenderer.invoke('generate-tldr', messageContent),

	// Chat management
	getChats: () =>
		ipcRenderer.invoke('get-chats'),

	getChat: (chatId: string) =>
		ipcRenderer.invoke('get-chat', chatId),

	createChat: (title?: string) =>
		ipcRenderer.invoke('create-chat', title),

	updateChat: (chatId: string, messages: any[], title?: string, databaseName?: string, branch?: string) =>
		ipcRenderer.invoke('update-chat', chatId, messages, title, databaseName, branch),

	deleteChat: (chatId: string) =>
		ipcRenderer.invoke('delete-chat', chatId),

	// Progress updates
	onMessageProgress: (callback: (status: string) => void) => {
		const listener = (_event: any, status: string) => callback(status);
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

	// User settings
	getUserName: () =>
		ipcRenderer.invoke('get-user-name'),

	saveUserName: (userName: string) =>
		ipcRenderer.invoke('save-user-name', userName),

	getAutoTldr: () =>
		ipcRenderer.invoke('get-auto-tldr'),

	saveAutoTldr: (autoTldr: boolean) =>
		ipcRenderer.invoke('save-auto-tldr', autoTldr),

	// Window focus
	focusWindow: () =>
		ipcRenderer.invoke('focus-window'),

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
