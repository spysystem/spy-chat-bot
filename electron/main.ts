import {app, BrowserWindow, ipcMain} from 'electron';
import {autoUpdater} from 'electron-updater';
import * as path from 'path';
import type {ChatMessage, ChatUpdate} from './services/chat-service';
import {ChatService} from './services/chat-service';
import {ClaudeService} from './services/claude-service';
import {AttachmentService} from './services/attachment-service';
import {DatabaseService} from './services/database-service';
import {SchemaIndexService} from './services/schema-index-service';
import type {GitHubConfig} from './services/github-service';
import {GitHubService} from './services/github-service';
import {SecureStorageService} from './services/secure-storage-service';
import {SettingsService} from './services/settings-service';
import {SystemDirectoryService} from './services/system-directory-service';
import type {DatabaseConfig} from './types';

let mainWindow: BrowserWindow | null  = null;
let debugWindow: BrowserWindow | null = null;
let pendingDeepLink: string | null    = null;

// Initialize services with secure storage
const secureStorage          = new SecureStorageService();
const claudeService          = new ClaudeService(secureStorage);
const databaseService        = new DatabaseService(secureStorage);
const schemaIndexService     = new SchemaIndexService();
const attachmentService      = new AttachmentService(10 * 1024 * 1024);
const chatService            = new ChatService();
const githubService          = new GitHubService(secureStorage);
const settingsService        = new SettingsService();
const systemDirectoryService = new SystemDirectoryService();

// Configure auto-updater
autoUpdater.autoDownload         = true;
autoUpdater.autoInstallOnAppQuit = true;

if (process.env.GH_TOKEN) {
	autoUpdater.setFeedURL({
		provider: 'github',
		owner   : 'spysystem',
		repo    : 'spy-chat-bot',
		token   : process.env.GH_TOKEN,
	});
}

// Debug logging helper
function sendDebugLog(type: 'query' | 'tool' | 'api' | 'error' | 'info', category: string, message: string, details?: string): void {
	if (debugWindow && !debugWindow.isDestroyed()) {
		debugWindow.webContents.send('debug-log', {
			timestamp: new Date().toISOString(),
			type,
			category,
			message,
			details,
		});
	}
}

// Handle deep links
function handleDeepLink(url: string): void {
	if (mainWindow && !mainWindow.isDestroyed()) {
		// Window is ready, send to renderer
		mainWindow.webContents.send('deep-link', url);
		mainWindow.focus();
	} else {
		// Window not ready yet, store for later
		pendingDeepLink = url;
	}
}

function createWindow(): void {
	const preloadPath = path.join(__dirname, 'preload.js');

	mainWindow = new BrowserWindow({
		width         : 1700,
		height        : 1000,
		webPreferences: {
			preload         : preloadPath,
			nodeIntegration : false,
			contextIsolation: true,
		},
	});

	// Check if we're in development mode
	const isDev = !app.isPackaged;

	if (isDev) {
		mainWindow.loadURL('http://localhost:5173');
	} else {
		const indexPath = path.join(__dirname, '../renderer/index.html');
		mainWindow.loadFile(indexPath);
	}

	mainWindow.on('closed', () => {
		mainWindow = null;
	});

	// Send pending deep link if exists
	mainWindow.webContents.on('did-finish-load', () => {
		if (pendingDeepLink && mainWindow) {
			mainWindow.webContents.send('deep-link', pendingDeepLink);
			pendingDeepLink = null;
		}
	});
}

function createDebugWindow(): void {
	// If debug window already exists, focus it
	if (debugWindow && !debugWindow.isDestroyed()) {
		debugWindow.focus();
		return;
	}

	const preloadPath = path.join(__dirname, 'preload.js');

	debugWindow = new BrowserWindow({
		width         : 1700,
		height        : 1000,
		title         : 'Debug Console - Spørge Jørgen',
		webPreferences: {
			preload         : preloadPath,
			nodeIntegration : false,
			contextIsolation: true,
		},
	});

	// Check if we're in development mode
	const isDev = !app.isPackaged;

	if (isDev) {
		debugWindow.loadURL('http://localhost:5173/#debug');
	} else {
		const indexPath = path.join(__dirname, '../renderer/index.html');
		debugWindow.loadFile(indexPath, {hash: 'debug'});
	}

	debugWindow.on('closed', () => {
		debugWindow = null;
	});
}

// Make app single instance (Windows/Linux)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
	app.quit();
} else {
	// Handle deep link when app is already running (Windows/Linux)
	app.on('second-instance', (_event, commandLine) => {
		// Protocol handler argument
		const url = commandLine.find((arg) => arg.startsWith('sporge-jorgen://'));
		if (url) {
			handleDeepLink(url);
		}

		// Focus window
		if (mainWindow) {
			if (mainWindow.isMinimized()) {
				mainWindow.restore();
			}
			mainWindow.focus();
		}
	});

	app.whenReady().then(() => {
		createWindow();

		// Register protocol handler (Windows/Linux)
		app.setAsDefaultProtocolClient('sporge-jorgen');

		// Check for updates after 3 seconds (only in production)
		if (!app.isPackaged) {
			console.log('[AutoUpdater] Skipping update check in development mode');
		} else {
			setTimeout(() => {
				console.log('[AutoUpdater] Checking for updates...');
				autoUpdater.checkForUpdates().catch((error) => {
					console.error('[AutoUpdater] Failed to check for updates:', error);
				});
			}, 3000);
		}

		app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) {
				createWindow();
			}
		});
	});
}

// Handle deep link on macOS
app.on('open-url', (event, url) => {
	event.preventDefault();
	handleDeepLink(url);
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

// IPC Handlers
ipcMain.handle('test-database-connection', async (_event, config: DatabaseConfig) => {
	return await databaseService.testConnection(config);
});

ipcMain.handle('save-database-config', async (_event, config: DatabaseConfig) => {
	return await databaseService.saveConfig(config);
});

ipcMain.handle('get-database-configs', async () => {
	return await databaseService.getConfigs();
});

ipcMain.handle('delete-database-config', async (_event, id: string) => {
	return await databaseService.deleteConfig(id);
});

// System directory (customer/system list)
ipcMain.handle('get-systems', async (_event, statuses?: string[]) => {
	return await systemDirectoryService.getSystems(statuses);
});

// Schema index
ipcMain.handle('get-schema-index-status', async (_event, configId: string) => {
	return await schemaIndexService.getStatus(configId);
});

ipcMain.handle('generate-schema-index', async (event, configId: string, databaseName: string) => {
	const onProgress = (progress: { stage: string; done: number; total: number }) => {
		event.sender.send('schema-index-progress', progress);
	};

	try {
		const status = await schemaIndexService.generateIndex(
			configId,
			databaseName,
			databaseService,
			onProgress,
		);
		event.sender.send('schema-index-complete', status);
		return status;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		event.sender.send('schema-index-error', message);
		throw error;
	}
});

// Attachments
ipcMain.handle('save-attachment', async (_event, chatId: string, originalName: string, mimeType: string | undefined, dataBase64: string) => {
	return await attachmentService.saveAttachment(chatId, originalName, mimeType, dataBase64);
});

ipcMain.handle('get-attachment-data-url', async (_event, storedPath: string, mimeType: string) => {
	return await attachmentService.getImageDataUrl(storedPath, mimeType);
});

ipcMain.handle('open-attachment', async (_event, storedPath: string) => {
	return await attachmentService.openAttachment(storedPath);
});

ipcMain.handle('send-message', async (event, chatId: string, message: string, databases: string[], history?: Array<{
	role: string;
	content: string
}>, chatContext?: { databaseName?: string; dbHost?: string; githubBranch?: string }, attachments?: any[]) => {
	const onProgress = (status: string) => {
		event.sender.send('message-progress', status);
	};

	const onDebugLog = (type: 'query' | 'tool' | 'api' | 'error' | 'info', category: string, message: string, details?: string) => {
		sendDebugLog(type, category, message, details);
	};

	return await claudeService.sendMessage(
		chatId,
		message,
		databases,
		databaseService,
		githubService,
		schemaIndexService,
		chatService,
		attachmentService,
		onProgress,
		history,
		chatContext?.databaseName,
		chatContext?.dbHost,
		chatContext?.githubBranch,
		attachments,
		onDebugLog,
	);
});

ipcMain.handle('get-api-key', async () => {
	return await claudeService.getApiKey();
});

ipcMain.handle('save-api-key', async (_event, apiKey: string) => {
	try {
		await claudeService.saveApiKey(apiKey);
	} catch (error) {
		console.error('[Main] Error saving API key:', error);
		throw error;
	}
});

// Chat management
ipcMain.handle('get-chats', async () => {
	return await chatService.getChats();
});

ipcMain.handle('get-chat', async (_event, chatId: string) => {
	return await chatService.getChat(chatId);
});

ipcMain.handle('create-chat', async (_event, title?: string) => {
	return await chatService.createChat(title);
});

ipcMain.handle('update-chat', async (_event, chatId: string, messages: ChatMessage[], updateOrTitle?: ChatUpdate | string, databaseName?: string, branch?: string) => {
	// Backwards compatibility: older renderer passed (title, databaseName, branch).
	if (typeof updateOrTitle === 'string' || databaseName !== undefined || branch !== undefined) {
		const update: ChatUpdate = {
			title: typeof updateOrTitle === 'string' ? updateOrTitle : undefined,
			databaseName,
			branch,
		};
		return await chatService.updateChat(chatId, messages, update);
	}

	return await chatService.updateChat(chatId, messages, updateOrTitle as ChatUpdate | undefined);
});

ipcMain.handle('delete-chat', async (_event, chatId: string) => {
	return await chatService.deleteChat(chatId);
});

ipcMain.handle('set-working-summary', async (_event, chatId: string, text: string) => {
	return await chatService.setWorkingSummary(chatId, text);
});

ipcMain.handle('clear-working-summary', async (_event, chatId: string) => {
	return await chatService.clearWorkingSummary(chatId);
});

// GitHub configuration
ipcMain.handle('get-github-config', async () => {
	return await githubService.getConfig();
});

ipcMain.handle('save-github-config', async (_event, config: GitHubConfig) => {
	return await githubService.saveConfig(config);
});

ipcMain.handle('validate-github-config', async () => {
	return await githubService.validateConfig();
});

// User settings
ipcMain.handle('get-user-name', async () => {
	return await settingsService.getUserName();
});

ipcMain.handle('save-user-name', async (_event, userName: string) => {
	return await settingsService.saveUserName(userName);
});

// Debug window
ipcMain.handle('open-debug-window', () => {
	createDebugWindow();
});

// Window focus
ipcMain.handle('focus-window', async () => {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.focus();
	}
});

// Auto-updater IPC handlers
ipcMain.handle('check-for-updates', async () => {
	try {
		const result = await autoUpdater.checkForUpdates();
		return {
			available     : result?.updateInfo.version !== app.getVersion(),
			version       : result?.updateInfo.version,
			currentVersion: app.getVersion(),
		};
	} catch (error) {
		console.error('[AutoUpdater] Check for updates failed:', error);
		return {available: false, error: String(error)};
	}
});

ipcMain.handle('download-update', async () => {
	try {
		await autoUpdater.downloadUpdate();
		return {success: true};
	} catch (error) {
		console.error('[AutoUpdater] Download update failed:', error);
		return {success: false, error: String(error)};
	}
});

ipcMain.handle('install-update', () => {
	autoUpdater.quitAndInstall();
});

ipcMain.handle('get-app-version', () => {
	return app.getVersion();
});

// Auto-updater events
autoUpdater.on('update-available', (info) => {
	console.log('[AutoUpdater] Update available:', info.version);
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send('update-available', info);
	}
});

autoUpdater.on('update-not-available', () => {
	console.log('[AutoUpdater] Update not available');
});

autoUpdater.on('download-progress', (progress) => {
	console.log('[AutoUpdater] Download progress:', Math.round(progress.percent) + '%');
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send('update-download-progress', progress);
	}
});

autoUpdater.on('update-downloaded', () => {
	console.log('[AutoUpdater] Update downloaded');
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send('update-downloaded');
	}
});

autoUpdater.on('error', (error) => {
	console.error('[AutoUpdater] Error:', error);
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send('update-error', error.message);
	}
});
