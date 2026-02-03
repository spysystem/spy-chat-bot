"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    testDatabaseConnection: function (config) {
        return electron_1.ipcRenderer.invoke('test-database-connection', config);
    },
    saveDatabaseConfig: function (config) {
        return electron_1.ipcRenderer.invoke('save-database-config', config);
    },
    getDatabaseConfigs: function () {
        return electron_1.ipcRenderer.invoke('get-database-configs');
    },
    deleteDatabaseConfig: function (id) {
        return electron_1.ipcRenderer.invoke('delete-database-config', id);
    },
    sendMessage: function (message, databases, history, databaseName) {
        return electron_1.ipcRenderer.invoke('send-message', message, databases, history, databaseName);
    },
    getApiKey: function () {
        return electron_1.ipcRenderer.invoke('get-api-key');
    },
    saveApiKey: function (apiKey) {
        return electron_1.ipcRenderer.invoke('save-api-key', apiKey);
    },
    generateTldr: function (messageContent) {
        return electron_1.ipcRenderer.invoke('generate-tldr', messageContent);
    },
    // Chat management
    getChats: function () {
        return electron_1.ipcRenderer.invoke('get-chats');
    },
    getChat: function (chatId) {
        return electron_1.ipcRenderer.invoke('get-chat', chatId);
    },
    createChat: function (title) {
        return electron_1.ipcRenderer.invoke('create-chat', title);
    },
    updateChat: function (chatId, messages, title, databaseName, branch) {
        return electron_1.ipcRenderer.invoke('update-chat', chatId, messages, title, databaseName, branch);
    },
    deleteChat: function (chatId) {
        return electron_1.ipcRenderer.invoke('delete-chat', chatId);
    },
    // Progress updates
    onMessageProgress: function (callback) {
        var listener = function (_event, status) { return callback(status); };
        electron_1.ipcRenderer.on('message-progress', listener);
        return function () {
            electron_1.ipcRenderer.removeListener('message-progress', listener);
        };
    },
    // GitHub configuration
    getGitHubConfig: function () {
        return electron_1.ipcRenderer.invoke('get-github-config');
    },
    saveGitHubConfig: function (config) {
        return electron_1.ipcRenderer.invoke('save-github-config', config);
    },
    validateGitHubConfig: function () {
        return electron_1.ipcRenderer.invoke('validate-github-config');
    },
    // User settings
    getUserName: function () {
        return electron_1.ipcRenderer.invoke('get-user-name');
    },
    saveUserName: function (userName) {
        return electron_1.ipcRenderer.invoke('save-user-name', userName);
    },
    getAutoTldr: function () {
        return electron_1.ipcRenderer.invoke('get-auto-tldr');
    },
    saveAutoTldr: function (autoTldr) {
        return electron_1.ipcRenderer.invoke('save-auto-tldr', autoTldr);
    },
    // Window focus
    focusWindow: function () {
        return electron_1.ipcRenderer.invoke('focus-window');
    },
    // Deep link handler
    onDeepLink: function (callback) {
        var listener = function (_event, url) { return callback(url); };
        electron_1.ipcRenderer.on('deep-link', listener);
        return function () {
            electron_1.ipcRenderer.removeListener('deep-link', listener);
        };
    },
    // Debug logging
    onDebugLog: function (callback) {
        var listener = function (_event, log) { return callback(log); };
        electron_1.ipcRenderer.on('debug-log', listener);
        return function () {
            electron_1.ipcRenderer.removeListener('debug-log', listener);
        };
    },
    // Debug window
    openDebugWindow: function () {
        return electron_1.ipcRenderer.invoke('open-debug-window');
    },
    // Auto-updater
    checkForUpdates: function () {
        return electron_1.ipcRenderer.invoke('check-for-updates');
    },
    downloadUpdate: function () {
        return electron_1.ipcRenderer.invoke('download-update');
    },
    installUpdate: function () {
        return electron_1.ipcRenderer.invoke('install-update');
    },
    getAppVersion: function () {
        return electron_1.ipcRenderer.invoke('get-app-version');
    },
    onUpdateAvailable: function (callback) {
        var listener = function (_event, info) { return callback(info); };
        electron_1.ipcRenderer.on('update-available', listener);
        return function () {
            electron_1.ipcRenderer.removeListener('update-available', listener);
        };
    },
    onUpdateDownloadProgress: function (callback) {
        var listener = function (_event, progress) { return callback(progress); };
        electron_1.ipcRenderer.on('update-download-progress', listener);
        return function () {
            electron_1.ipcRenderer.removeListener('update-download-progress', listener);
        };
    },
    onUpdateDownloaded: function (callback) {
        var listener = function () { return callback(); };
        electron_1.ipcRenderer.on('update-downloaded', listener);
        return function () {
            electron_1.ipcRenderer.removeListener('update-downloaded', listener);
        };
    },
    onUpdateError: function (callback) {
        var listener = function (_event, error) { return callback(error); };
        electron_1.ipcRenderer.on('update-error', listener);
        return function () {
            electron_1.ipcRenderer.removeListener('update-error', listener);
        };
    },
});
