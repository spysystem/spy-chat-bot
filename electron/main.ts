import {app, BrowserWindow, ipcMain, Menu, shell} from 'electron';
import {autoUpdater} from 'electron-updater';
import * as path from 'path';
import type {ChatMessage, ChatUpdate} from './services/chat-service';
import {ChatService} from './services/chat-service';
import {ClaudeService} from './services/claude-service';
import {OpenAIService} from './services/openai-service';
import {AIOrchestrator} from './services/ai-orchestrator';
import {AttachmentService} from './services/attachment-service';
import {DatabaseService} from './services/database-service';
import {SchemaIndexService} from './services/schema-index-service';
import type {GitHubConfig} from './services/github-service';
import {GitHubService} from './services/github-service';
import {GitInstallerService} from './services/git-installer-service';
import {LATENCY_FLAGS} from './services/latency-flags';
import {SecureStorageService} from './services/secure-storage-service';
import type {AiQualityProfile} from './services/settings-service';
import {SettingsService} from './services/settings-service';
import {SpyCodeAiMcpService} from './services/spy-code-ai-mcp-service';
import {SystemDirectoryService} from './services/system-directory-service';
import type {DatabaseConfig} from './types';

let mainWindow: BrowserWindow | null  = null;
let debugWindow: BrowserWindow | null = null;
let pendingDeepLink: string | null    = null;

type DebugLogType = 'query' | 'tool' | 'api' | 'error' | 'info';
type DebugLogPhase = 'prepare' | 'retrieval' | 'technical' | 'postprocess' | 'tool' | 'stream' | 'ipc' | 'background' | 'other';
type DebugLogStatus = 'started' | 'completed' | 'failed' | 'info';

interface DebugLogEntry {
	id: string;
	timestamp: string;
	type: DebugLogType;
	category: string;
	message: string;
	details?: string;
	chatId?: string;
	runId?: string;
	provider?: 'claude' | 'openai';
	phase?: DebugLogPhase;
	toolName?: string;
	durationMs?: number;
	status?: DebugLogStatus;
	rowCount?: number;
	meta?: Record<string, string | number | boolean | null | undefined>;
}

interface DebugLogContext {
	chatId?: string;
	runId?: string;
	provider?: 'claude' | 'openai';
	phase?: DebugLogPhase;
	toolName?: string;
	durationMs?: number;
	status?: DebugLogStatus;
	rowCount?: number;
	meta?: Record<string, string | number | boolean | null | undefined>;
}

// Initialize services with secure storage
const secureStorage          = new SecureStorageService();
const claudeService          = new ClaudeService(secureStorage);
const openaiService          = new OpenAIService(secureStorage);
const aiOrchestrator         = new AIOrchestrator(claudeService, openaiService);
const databaseService        = new DatabaseService(secureStorage);
const schemaIndexService     = new SchemaIndexService();
const spyCodeAiMcpService    = new SpyCodeAiMcpService();
const attachmentService      = new AttachmentService(10 * 1024 * 1024);
const chatService            = new ChatService();
const githubService          = new GitHubService(secureStorage);
const settingsService        = new SettingsService();
const systemDirectoryService = new SystemDirectoryService();
const gitInstallerService    = new GitInstallerService();
const aiStreamControllers    = new Map<string, AbortController>();

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

function inferPhase(type: DebugLogType, category: string): DebugLogPhase {
	const normalized = category.toLowerCase();
	if (type === 'query') {
		return 'technical';
	}
	if (type === 'tool') {
		return 'tool';
	}
	if (normalized.includes('working summary')) {
		return 'postprocess';
	}
	if (normalized.includes('vector') || normalized.includes('schema cache') || normalized.includes('context')) {
		return 'retrieval';
	}
	if (normalized.includes('latency') || normalized.includes('tanstack') || normalized.includes('openai api') || normalized.includes('claude api')) {
		return 'technical';
	}
	if (normalized.includes('git local sync') || normalized.includes('worktree')) {
		return 'background';
	}
	return type === 'api' ? 'ipc' : 'other';
}

function createDebugLogger(baseContext: DebugLogContext): (type: DebugLogType, category: string, message: string, details?: string, extraContext?: DebugLogContext) => void {
	return (type, category, message, details, extraContext) => {
		sendDebugLog(type, category, message, details, {...baseContext, ...extraContext});
	};
}

function truncateDebugText(text: string, maxLength: number = 4000): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength)}\n\n[truncated ${text.length - maxLength} chars]`;
}

function formatTanStackEventDetails(aiEvent: any): string {
	if (!aiEvent || typeof aiEvent !== 'object') {
		return '(no event payload)';
	}

	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(aiEvent)) {
		if (value === undefined) {
			continue;
		}
		if (key === 'result' && typeof value === 'object' && value !== null) {
			try {
				payload.resultPreview = truncateDebugText(JSON.stringify(value, null, 2), 2500);
			} catch {
				payload.resultPreview = '[unserializable result]';
			}
			continue;
		}
		if (key === 'error') {
			if (value instanceof Error) {
				payload.error = {message: value.message, stack: value.stack};
			} else {
				payload.error = value;
			}
			continue;
		}
		payload[key] = value;
	}

	try {
		return truncateDebugText(JSON.stringify(payload, null, 2));
	} catch {
		return '(failed to serialize event payload)';
	}
}

// Debug logging helper
function sendDebugLog(type: DebugLogType, category: string, message: string, details?: string, context: DebugLogContext = {}): void {
	if (debugWindow && !debugWindow.isDestroyed()) {
		const entry: DebugLogEntry = {
			id        : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			timestamp : new Date().toISOString(),
			type,
			category,
			message,
			details,
			chatId    : context.chatId,
			runId     : context.runId,
			provider  : context.provider,
			phase     : context.phase || inferPhase(type, category),
			toolName  : context.toolName,
			durationMs: context.durationMs,
			status    : context.status || (type === 'error' ? 'failed' : 'info'),
			rowCount  : context.rowCount,
			meta      : context.meta,
		};
		debugWindow.webContents.send('debug-log', entry);
	}
}

function sendLocalRepoSyncProgress(progress: { stage: string; percent?: number; message?: string }): void {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send('local-repo-sync-progress', progress);
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

	// Context menu for text editing (copy/paste/cut)
	mainWindow.webContents.on('context-menu', (_event, params) => {
		const {isEditable, selectionText, editFlags} = params;

		// Only show context menu for editable fields or when text is selected
		if (!isEditable && !selectionText) {
			return;
		}

		const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

		if (isEditable) {
			menuTemplate.push(
				{
					label      : 'Cut',
					accelerator: 'CmdOrCtrl+X',
					role       : 'cut',
					enabled    : editFlags.canCut,
				},
			);
		}

		menuTemplate.push(
			{
				label      : 'Copy',
				accelerator: 'CmdOrCtrl+C',
				role       : 'copy',
				enabled    : editFlags.canCopy,
			},
		);

		if (isEditable) {
			menuTemplate.push(
				{
					label      : 'Paste',
					accelerator: 'CmdOrCtrl+V',
					role       : 'paste',
					enabled    : editFlags.canPaste,
				},
			);
		}

		menuTemplate.push({type: 'separator'});

		menuTemplate.push(
			{
				label      : 'Select All',
				accelerator: 'CmdOrCtrl+A',
				role       : 'selectAll',
				enabled    : editFlags.canSelectAll,
			},
		);

		const menu = Menu.buildFromTemplate(menuTemplate);
		menu.popup();
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

	// Context menu for text editing (copy/paste/cut)
	debugWindow.webContents.on('context-menu', (_event, params) => {
		const {isEditable, selectionText, editFlags} = params;

		if (!isEditable && !selectionText) {
			return;
		}

		const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

		if (isEditable) {
			menuTemplate.push({
				label      : 'Cut',
				accelerator: 'CmdOrCtrl+X',
				role       : 'cut',
				enabled    : editFlags.canCut,
			});
		}

		menuTemplate.push({
			label      : 'Copy',
			accelerator: 'CmdOrCtrl+C',
			role       : 'copy',
			enabled    : editFlags.canCopy,
		});

		if (isEditable) {
			menuTemplate.push({
				label      : 'Paste',
				accelerator: 'CmdOrCtrl+V',
				role       : 'paste',
				enabled    : editFlags.canPaste,
			});
		}

		menuTemplate.push({type: 'separator'});

		menuTemplate.push({
			label      : 'Select All',
			accelerator: 'CmdOrCtrl+A',
			role       : 'selectAll',
			enabled    : editFlags.canSelectAll,
		});

		const menu = Menu.buildFromTemplate(menuTemplate);
		menu.popup();
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

		void settingsService.getLocalRepoUrl().then((localRepoUrl) => {
			if (localRepoUrl) {
				githubService.setLocalRepoUrl(localRepoUrl);
			}
		});

		setInterval(async () => {
			const localRepoUrl = githubService.getLocalRepoUrl();
			if (!localRepoUrl) {
				return;
			}
			try {
				await githubService.ensureLocalRepo(localRepoUrl, {fetch: true});
				sendDebugLog('info', 'Git Local Sync', 'Background fetch completed');
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendDebugLog('error', 'Git Local Sync', 'Background fetch failed', message);
			}
		}, 20 * 60 * 1000);

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
ipcMain.handle('get-schema-index-status', async (_event, configId: string, branch?: string) => {
	return await schemaIndexService.getStatus(configId, {branch});
});

ipcMain.handle('generate-schema-index', async (event, configId: string, databaseName: string, branch?: string) => {
	const onProgress = (progress: { stage: string; done: number; total: number }) => {
		event.sender.send('schema-index-progress', progress);
	};

	try {
		const status = await schemaIndexService.generateIndex(
			configId,
			databaseName,
			databaseService,
			onProgress,
			{branch},
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
	const [selectedModel, aiQualityProfile] = await Promise.all([
		settingsService.getSelectedModel(),
		settingsService.getAiQualityProfile(),
	]);
	const onProgress                        = (status: string) => {
		event.sender.send('message-progress', {chatId, streamId: '', status});
	};
	const runId                             = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const log                               = createDebugLogger({chatId, runId, provider: selectedModel, phase: 'ipc'});
	log('info', 'IPC', 'Synchronous send-message request started', undefined, {
		status: 'started',
		meta  : {
			databaseCount : databases.length,
			hasHistory    : !!history?.length,
			hasAttachments: !!attachments?.length,
			provider      : selectedModel,
			qualityProfile: aiQualityProfile,
		},
	});

	const onDebugLog = (type: DebugLogType, category: string, messageText: string, details?: string) => {
		log(type, category, messageText, details);
	};

	try {
		const result = await aiOrchestrator.sendMessage(
			selectedModel === 'openai' ? 'openai' : 'claude',
			{
				chatId,
				userMessage         : message,
				databaseIds         : databases,
				databaseService,
				githubService,
				schemaIndexService,
				spyCodeAiMcpService,
				chatService,
				attachmentService,
				onProgress,
				conversationHistory : history,
				databaseName        : chatContext?.databaseName,
				dbHostOverride      : chatContext?.dbHost,
				githubBranchOverride: chatContext?.githubBranch,
				attachments,
				aiQualityProfile,
				onDebugLog,
			},
		);
		log('info', 'IPC', 'Synchronous send-message request finished', undefined, {
			status: 'completed',
			meta  : {terminal: true},
		});
		return result;
	} catch (error) {
		log('error', 'IPC', 'Synchronous send-message request failed', error instanceof Error ? error.message : String(error), {status: 'failed'});
		throw error;
	}
});

ipcMain.handle('start-ai-stream', async (event, chatId: string, message: string, databases: string[], history?: Array<{
	role: string;
	content: string;
}>, chatContext?: { databaseName?: string; dbHost?: string; githubBranch?: string }, attachments?: any[]) => {
	const streamId        = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const abortController = new AbortController();
	aiStreamControllers.set(streamId, abortController);
	const [selectedModel, aiQualityProfile] = await Promise.all([
		settingsService.getSelectedModel(),
		settingsService.getAiQualityProfile(),
	]);
	const log                               = createDebugLogger({chatId, runId: streamId, provider: selectedModel, phase: 'ipc'});
	const startMs                           = Date.now();
	let firstTokenMs: number | null         = null;
	let textChunkCount                      = 0;
	let thinkingCount                       = 0;
	let toolCallCount                       = 0;
	const toolStartMap                      = new Map<string, number>();
	const toolStats                         = new Map<string, { count: number; totalMs: number; maxMs: number }>();
	let totalToolMs                         = 0;

	const onProgress = (status: string) => {
		event.sender.send('message-progress', {chatId, streamId, status});
	};
	log('info', 'IPC', 'AI stream started', undefined, {
		status: 'started',
		meta  : {
			databaseCount : databases.length,
			hasHistory    : !!history?.length,
			hasAttachments: !!attachments?.length,
			databaseName  : chatContext?.databaseName || null,
			githubBranch  : chatContext?.githubBranch || null,
			qualityProfile: aiQualityProfile,
		},
	});
	log('info', 'Latency Flags', 'Active latency flags', JSON.stringify(LATENCY_FLAGS), {phase: 'prepare'});

	const onDebugLog = (type: DebugLogType, category: string, messageText: string, details?: string) => {
		log(type, category, messageText, details);
	};

	const onEvent = (aiEvent: any) => {
		event.sender.send('ai-event', {streamId, event: aiEvent});
		if (!aiEvent || !aiEvent.type) {
			return;
		}
		switch (aiEvent.type) {
			case 'RUN_STARTED':
				log('info', 'TanStack AI', `Stream started (${streamId})`, formatTanStackEventDetails(aiEvent), {
					phase : 'stream',
					status: 'started',
				});
				break;
			case 'TEXT_MESSAGE_CONTENT':
				textChunkCount += 1;
				if (firstTokenMs === null) {
					firstTokenMs = Date.now();
					log('info', 'TanStack AI', `First token in ${firstTokenMs - startMs} ms`, undefined, {
						phase     : 'stream',
						durationMs: firstTokenMs - startMs,
					});
				}
				break;
			case 'STEP_FINISHED':
				thinkingCount += 1;
				log(
					'info',
					'AI Thinking',
					`Thinking step ${thinkingCount} finished`,
					formatTanStackEventDetails(aiEvent),
					{
						phase : 'stream',
						status: 'info',
					},
				);
				break;
			case 'STEP_STARTED':
				log(
					'info',
					'AI Thinking',
					'Thinking step started',
					formatTanStackEventDetails(aiEvent),
					{
						phase : 'stream',
						status: 'started',
					},
				);
				break;
			case 'TOOL_CALL_START':
				toolCallCount += 1;
				if (aiEvent.toolCallId) {
					toolStartMap.set(String(aiEvent.toolCallId), Date.now());
				}
				log('tool', 'TanStack AI Tool', `Tool start: ${aiEvent.toolName || 'unknown'}`, formatTanStackEventDetails(aiEvent), {
					phase   : 'tool',
					status  : 'started',
					toolName: aiEvent.toolName || 'unknown',
				});
				break;
			case 'TOOL_CALL_END': {
				const toolId    = aiEvent.toolCallId ? String(aiEvent.toolCallId) : '';
				const startedAt = toolId ? toolStartMap.get(toolId) : undefined;
				if (startedAt) {
					const durationMs = Date.now() - startedAt;
					const toolName   = aiEvent.toolName || 'unknown';
					totalToolMs += durationMs;
					const stats      = toolStats.get(toolName) || {count: 0, totalMs: 0, maxMs: 0};
					stats.count += 1;
					stats.totalMs += durationMs;
					stats.maxMs      = Math.max(stats.maxMs, durationMs);
					toolStats.set(toolName, stats);
					log('tool', 'TanStack AI Tool', `Tool end: ${aiEvent.toolName || 'unknown'} (${durationMs} ms)`, formatTanStackEventDetails(aiEvent), {
						phase   : 'tool',
						status  : 'completed',
						toolName: aiEvent.toolName || 'unknown',
						durationMs,
					});
					toolStartMap.delete(toolId);
				} else {
					log('tool', 'TanStack AI Tool', `Tool end: ${aiEvent.toolName || 'unknown'}`, formatTanStackEventDetails(aiEvent), {
						phase   : 'tool',
						status  : 'completed',
						toolName: aiEvent.toolName || 'unknown',
					});
				}
				break;
			}
			case 'RUN_FINISHED': {
				const totalMs = Date.now() - startMs;
				log('info', 'TanStack AI', `Stream finished in ${totalMs} ms`, formatTanStackEventDetails(aiEvent), {
					phase     : 'stream',
					status    : 'completed',
					durationMs: totalMs,
				});
				log('info', 'TanStack AI', `Chunks: ${textChunkCount} | Thinking steps: ${thinkingCount} | Tools: ${toolCallCount}`, undefined, {
					phase: 'stream',
					meta : {
						textChunks   : textChunkCount,
						thinkingSteps: thinkingCount,
						toolCalls    : toolCallCount,
					},
				});
				if (selectedModel === 'openai' && thinkingCount === 0) {
					log(
						'info',
						'AI Thinking',
						'No visible thinking steps were emitted by OpenAI for this run',
						'This usually means the provider/model did not stream reasoning summaries for this request.',
						{
							phase : 'stream',
							status: 'info',
						},
					);
				}
				if (toolStats.size > 0) {
					const toolSummary = Array.from(toolStats.entries())
						.sort((a, b) => b[1].totalMs - a[1].totalMs)
						.slice(0, 5)
						.map(([name, stats]) => `${name}: ${stats.count} calls, ${stats.totalMs} ms total, ${stats.maxMs} ms max`)
						.join(' | ');
					log('info', 'TanStack AI', `Tool time: ${totalToolMs} ms total`, toolSummary, {
						phase     : 'stream',
						durationMs: totalToolMs,
					});
				}
				break;
			}
			case 'RUN_ERROR':
				log('error', 'TanStack AI', `Stream error: ${aiEvent.error?.message || 'Unknown error'}`, formatTanStackEventDetails(aiEvent), {
					phase : 'stream',
					status: 'failed',
				});
				break;
			default:
				break;
		}
	};

	void (async () => {
		try {
			// Pre-create worktree for the branch if local repo is configured
			// This ensures code search is instant when AI uses it
			const localRepoUrl = githubService.getLocalRepoUrl();
			const branch       = chatContext?.githubBranch?.trim();
			if (localRepoUrl && branch) {
				const githubConfig    = await githubService.getConfig();
				const effectiveBranch = branch || githubConfig?.branch || 'main';
				try {
					sendDebugLog('info', 'Worktree', `Ensuring worktree exists for branch: ${effectiveBranch}`, `Requested by chat branch override: ${branch}`);
					const worktreeResult = await githubService.ensureWorktree(effectiveBranch, localRepoUrl, {fetch: true});
					sendDebugLog(
						'info',
						'Worktree',
						`Worktree ready for branch: ${effectiveBranch}`,
						`path=${worktreeResult.worktreePath}; existed=${worktreeResult.existed}; fetched=${worktreeResult.fetched}; fetchReason=${worktreeResult.fetchReason}`,
					);
				} catch (worktreeError) {
					const wtMessage = worktreeError instanceof Error ? worktreeError.message : String(worktreeError);
					sendDebugLog('error', 'Worktree', `Failed to ensure worktree for ${effectiveBranch}`, wtMessage);
					// Don't fail the whole request - code search will try again later
				}
			} else if (localRepoUrl) {
				sendDebugLog(
					'info',
					'Worktree',
					'No chat-specific branch override was provided',
					'Code search will fall back to the configured default branch if needed.',
				);
			}

			const result = await aiOrchestrator.sendMessage(
				selectedModel === 'openai' ? 'openai' : 'claude',
				{
					chatId,
					userMessage         : message,
					databaseIds         : databases,
					databaseService,
					githubService,
					schemaIndexService,
					spyCodeAiMcpService,
					chatService,
					attachmentService,
					onProgress,
					conversationHistory : history,
					databaseName        : chatContext?.databaseName,
					dbHostOverride      : chatContext?.dbHost,
					githubBranchOverride: chatContext?.githubBranch,
					attachments,
					aiQualityProfile,
					onDebugLog,
					onEvent,
					abortController,
				},
			);
			if (result && 'needsClarification' in result && result.needsClarification) {
				log('info', 'Clarification', 'AI requested clarification', result.question, {
					phase : 'technical',
					status: 'completed',
					meta  : {terminal: true, clarification: true},
				});
				event.sender.send('ai-asking-clarification', {
					streamId,
					chatId,
					provider     : selectedModel,
					question     : result.question,
					options      : result.options,
					allowFreeText: result.allowFreeText,
				});
			} else {
				log('info', 'IPC', 'AI stream finished with final result', undefined, {
					status: 'completed',
					meta  : {terminal: true},
				});
				event.sender.send('ai-finished', {streamId, provider: selectedModel, result});
			}
		} catch (error) {
			const messageText = error instanceof Error ? error.message : String(error);
			event.sender.send('ai-error', {streamId, error: messageText});
			log('error', 'Latency', `Stream failed after ${Date.now() - startMs} ms`, messageText, {
				phase     : 'ipc',
				status    : 'failed',
				durationMs: Date.now() - startMs,
			});
		} finally {
			log('info', 'Latency', `IPC stream total ${Date.now() - startMs} ms`, `streamId=${streamId} firstTokenMs=${firstTokenMs ? firstTokenMs - startMs : -1} toolCalls=${toolCallCount}`, {
				phase     : 'ipc',
				durationMs: Date.now() - startMs,
				meta      : {
					firstTokenMs: firstTokenMs ? firstTokenMs - startMs : -1,
					toolCalls   : toolCallCount,
					textChunks  : textChunkCount,
				},
			});
			aiStreamControllers.delete(streamId);
		}
	})();

	return {streamId};
});

ipcMain.handle('stop-ai-stream', async (_event, streamId: string) => {
	const controller = aiStreamControllers.get(streamId);
	if (controller) {
		controller.abort();
		aiStreamControllers.delete(streamId);
	}
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

ipcMain.handle('get-openai-api-key', async () => {
	return await openaiService.getApiKey();
});

ipcMain.handle('save-openai-api-key', async (_event, apiKey: string) => {
	try {
		await openaiService.saveApiKey(apiKey);
	} catch (error) {
		console.error('[Main] Error saving OpenAI API key:', error);
		throw error;
	}
});

ipcMain.handle('get-selected-model', async () => {
	return await settingsService.getSelectedModel();
});

ipcMain.handle('save-selected-model', async (_event, model: 'claude' | 'openai') => {
	await settingsService.saveSelectedModel(model);
});

ipcMain.handle('get-ai-quality-profile', async () => {
	return await settingsService.getAiQualityProfile();
});

ipcMain.handle('save-ai-quality-profile', async (_event, profile: AiQualityProfile) => {
	await settingsService.saveAiQualityProfile(profile);
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

ipcMain.handle('clear-all-chats', async () => {
	return await chatService.clearAllChats();
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

ipcMain.handle('get-local-repo-status', async () => {
	const localRepoUrl = await settingsService.getLocalRepoUrl();
	githubService.setLocalRepoUrl(localRepoUrl);
	return await githubService.getLocalRepoStatus();
});

ipcMain.handle('sync-local-repo', async (_event, url: string) => {
	const trimmedUrl = url.trim();
	if (!trimmedUrl) {
		return {success: false, error: 'Repository URL is required.'};
	}

	// Check if Git is installed first
	const gitInstalled = await gitInstallerService.isGitInstalled();
	if (!gitInstalled) {
		sendDebugLog('info', 'Git Local Sync', 'Git not found, prompting for installation');
		const installed = await gitInstallerService.promptAndInstall((progress) => {
			sendLocalRepoSyncProgress({stage: progress.stage, percent: progress.percent, message: progress.message});
		});
		if (!installed) {
			return {success: false, error: 'Git is required for Local Repository Sync. Please install Git and try again.'};
		}
	}

	try {
		await settingsService.saveLocalRepoUrl(trimmedUrl);
		githubService.setLocalRepoUrl(trimmedUrl);
		const result = await githubService.ensureLocalRepo(trimmedUrl, {
			fetch     : true,
			onProgress: (progress) => sendLocalRepoSyncProgress(progress),
		});
		sendDebugLog('info', 'Git Local Sync', `Local repository synced at ${result.repoPath}`);
		return {success: true, repoPath: result.repoPath};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		sendDebugLog('error', 'Git Local Sync', 'Local repository sync failed', message);
		return {success: false, error: message};
	}
});

// Git installation check
ipcMain.handle('check-git-installed', async () => {
	const installed = await gitInstallerService.isGitInstalled();
	const version   = installed ? await gitInstallerService.getGitVersion() : null;
	return {installed, version};
});

ipcMain.handle('install-git', async () => {
	const installed = await gitInstallerService.promptAndInstall((progress) => {
		sendLocalRepoSyncProgress({stage: progress.stage, percent: progress.percent, message: progress.message});
	});
	return {success: installed};
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

// Open external URL in default browser
ipcMain.handle('open-external-url', async (_event, url: string) => {
	try {
		await shell.openExternal(url);
		return {success: true};
	} catch (error) {
		return {success: false, error: error instanceof Error ? error.message : String(error)};
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
