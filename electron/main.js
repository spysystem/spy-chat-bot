"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var electron_1 = require("electron");
var electron_updater_1 = require("electron-updater");
var path = require("path");
var chat_service_1 = require("./services/chat-service");
var claude_service_1 = require("./services/claude-service");
var database_service_1 = require("./services/database-service");
var github_service_1 = require("./services/github-service");
var settings_service_1 = require("./services/settings-service");
var mainWindow = null;
var debugWindow = null;
var pendingDeepLink = null;
var claudeService = new claude_service_1.ClaudeService();
var databaseService = new database_service_1.DatabaseService();
var chatService = new chat_service_1.ChatService();
var githubService = new github_service_1.GitHubService();
var settingsService = new settings_service_1.SettingsService();
// Configure auto-updater
electron_updater_1.autoUpdater.autoDownload = false; // Don't auto-download, let user decide
electron_updater_1.autoUpdater.autoInstallOnAppQuit = true;
// Debug logging helper
function sendDebugLog(type, category, message, details) {
    if (debugWindow && !debugWindow.isDestroyed()) {
        debugWindow.webContents.send('debug-log', {
            timestamp: new Date().toISOString(),
            type: type,
            category: category,
            message: message,
            details: details,
        });
    }
}
// Handle deep links
function handleDeepLink(url) {
    console.log('[Main] Deep link received:', url);
    if (mainWindow && !mainWindow.isDestroyed()) {
        // Window is ready, send to renderer
        mainWindow.webContents.send('deep-link', url);
        mainWindow.focus();
    }
    else {
        // Window not ready yet, store for later
        pendingDeepLink = url;
    }
}
function createWindow() {
    var preloadPath = path.join(__dirname, 'preload.js');
    mainWindow = new electron_1.BrowserWindow({
        width: 1700,
        height: 1000,
        webPreferences: {
            preload: preloadPath,
            nodeIntegration: false,
            contextIsolation: true,
        },
    });
    // Check if we're in development mode
    var isDev = !electron_1.app.isPackaged;
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
    }
    else {
        var indexPath = path.join(__dirname, '../renderer/index.html');
        mainWindow.loadFile(indexPath);
    }
    mainWindow.on('closed', function () {
        mainWindow = null;
    });
    // Send pending deep link if exists
    mainWindow.webContents.on('did-finish-load', function () {
        if (pendingDeepLink && mainWindow) {
            mainWindow.webContents.send('deep-link', pendingDeepLink);
            pendingDeepLink = null;
        }
    });
}
function createDebugWindow() {
    // If debug window already exists, focus it
    if (debugWindow && !debugWindow.isDestroyed()) {
        debugWindow.focus();
        return;
    }
    var preloadPath = path.join(__dirname, 'preload.js');
    debugWindow = new electron_1.BrowserWindow({
        width: 1200,
        height: 800,
        title: 'Debug Console - Spørge Jørgen',
        webPreferences: {
            preload: preloadPath,
            nodeIntegration: false,
            contextIsolation: true,
        },
    });
    // Check if we're in development mode
    var isDev = !electron_1.app.isPackaged;
    if (isDev) {
        debugWindow.loadURL('http://localhost:5173/#debug');
    }
    else {
        var indexPath = path.join(__dirname, '../renderer/index.html');
        debugWindow.loadFile(indexPath, { hash: 'debug' });
    }
    debugWindow.on('closed', function () {
        debugWindow = null;
    });
}
// Make app single instance (Windows/Linux)
var gotTheLock = electron_1.app.requestSingleInstanceLock();
if (!gotTheLock) {
    electron_1.app.quit();
}
else {
    // Handle deep link when app is already running (Windows/Linux)
    electron_1.app.on('second-instance', function (_event, commandLine) {
        // Protocol handler argument
        var url = commandLine.find(function (arg) { return arg.startsWith('sporge-jorgen://'); });
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
    electron_1.app.whenReady().then(function () {
        createWindow();
        // Register protocol handler (Windows/Linux)
        electron_1.app.setAsDefaultProtocolClient('sporge-jorgen');
        // Check for updates after 3 seconds (only in production)
        if (!electron_1.app.isPackaged) {
            console.log('[AutoUpdater] Skipping update check in development mode');
        }
        else {
            setTimeout(function () {
                console.log('[AutoUpdater] Checking for updates...');
                electron_updater_1.autoUpdater.checkForUpdates().catch(function (error) {
                    console.error('[AutoUpdater] Failed to check for updates:', error);
                });
            }, 3000);
        }
        electron_1.app.on('activate', function () {
            if (electron_1.BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });
}
// Handle deep link on macOS
electron_1.app.on('open-url', function (event, url) {
    event.preventDefault();
    handleDeepLink(url);
});
electron_1.app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
// IPC Handlers
electron_1.ipcMain.handle('test-database-connection', function (_event, config) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, databaseService.testConnection(config)];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('save-database-config', function (_event, config) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, databaseService.saveConfig(config)];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('get-database-configs', function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, databaseService.getConfigs()];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('delete-database-config', function (_event, id) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, databaseService.deleteConfig(id)];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('send-message', function (event, message, databases, history, databaseName) { return __awaiter(void 0, void 0, void 0, function () {
    var onProgress, onDebugLog;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                onProgress = function (status) {
                    event.sender.send('message-progress', status);
                };
                onDebugLog = function (type, category, message, details) {
                    sendDebugLog(type, category, message, details);
                };
                return [4 /*yield*/, claudeService.sendMessage(message, databases, databaseService, githubService, onProgress, history, databaseName, onDebugLog)];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('get-api-key', function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, claudeService.getApiKey()];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('save-api-key', function (_event, apiKey) { return __awaiter(void 0, void 0, void 0, function () {
    var error_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                return [4 /*yield*/, claudeService.saveApiKey(apiKey)];
            case 1:
                _a.sent();
                return [3 /*break*/, 3];
            case 2:
                error_1 = _a.sent();
                console.error('[Main] Error saving API key:', error_1);
                throw error_1;
            case 3: return [2 /*return*/];
        }
    });
}); });
electron_1.ipcMain.handle('generate-tldr', function (_event, messageContent) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, claudeService.generateTldr(messageContent)];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
// Chat management
electron_1.ipcMain.handle('get-chats', function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, chatService.getChats()];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('get-chat', function (_event, chatId) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, chatService.getChat(chatId)];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('create-chat', function (_event, title) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, chatService.createChat(title)];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('update-chat', function (_event, chatId, messages, title, databaseName, branch) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, chatService.updateChat(chatId, messages, title, databaseName, branch)];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('delete-chat', function (_event, chatId) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, chatService.deleteChat(chatId)];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
// GitHub configuration
electron_1.ipcMain.handle('get-github-config', function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, githubService.getConfig()];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('save-github-config', function (_event, config) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, githubService.saveConfig(config)];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('validate-github-config', function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, githubService.validateConfig()];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
// User settings
electron_1.ipcMain.handle('get-user-name', function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, settingsService.getUserName()];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('save-user-name', function (_event, userName) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, settingsService.saveUserName(userName)];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('get-auto-tldr', function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, settingsService.getAutoTldr()];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
electron_1.ipcMain.handle('save-auto-tldr', function (_event, autoTldr) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, settingsService.saveAutoTldr(autoTldr)];
            case 1: return [2 /*return*/, _a.sent()];
        }
    });
}); });
// Debug window
electron_1.ipcMain.handle('open-debug-window', function () {
    createDebugWindow();
});
// Window focus
electron_1.ipcMain.handle('focus-window', function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.focus();
        }
        return [2 /*return*/];
    });
}); });
// Auto-updater IPC handlers
electron_1.ipcMain.handle('check-for-updates', function () { return __awaiter(void 0, void 0, void 0, function () {
    var result, error_2;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                return [4 /*yield*/, electron_updater_1.autoUpdater.checkForUpdates()];
            case 1:
                result = _a.sent();
                return [2 /*return*/, {
                        available: (result === null || result === void 0 ? void 0 : result.updateInfo.version) !== electron_1.app.getVersion(),
                        version: result === null || result === void 0 ? void 0 : result.updateInfo.version,
                        currentVersion: electron_1.app.getVersion(),
                    }];
            case 2:
                error_2 = _a.sent();
                console.error('[AutoUpdater] Check for updates failed:', error_2);
                return [2 /*return*/, { available: false, error: String(error_2) }];
            case 3: return [2 /*return*/];
        }
    });
}); });
electron_1.ipcMain.handle('download-update', function () { return __awaiter(void 0, void 0, void 0, function () {
    var error_3;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                return [4 /*yield*/, electron_updater_1.autoUpdater.downloadUpdate()];
            case 1:
                _a.sent();
                return [2 /*return*/, { success: true }];
            case 2:
                error_3 = _a.sent();
                console.error('[AutoUpdater] Download update failed:', error_3);
                return [2 /*return*/, { success: false, error: String(error_3) }];
            case 3: return [2 /*return*/];
        }
    });
}); });
electron_1.ipcMain.handle('install-update', function () {
    electron_updater_1.autoUpdater.quitAndInstall();
});
electron_1.ipcMain.handle('get-app-version', function () {
    return electron_1.app.getVersion();
});
// Auto-updater events
electron_updater_1.autoUpdater.on('update-available', function (info) {
    console.log('[AutoUpdater] Update available:', info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-available', info);
    }
});
electron_updater_1.autoUpdater.on('update-not-available', function () {
    console.log('[AutoUpdater] Update not available');
});
electron_updater_1.autoUpdater.on('download-progress', function (progress) {
    console.log('[AutoUpdater] Download progress:', Math.round(progress.percent) + '%');
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-download-progress', progress);
    }
});
electron_updater_1.autoUpdater.on('update-downloaded', function () {
    console.log('[AutoUpdater] Update downloaded');
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-downloaded');
    }
});
electron_updater_1.autoUpdater.on('error', function (error) {
    console.error('[AutoUpdater] Error:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-error', error.message);
    }
});
