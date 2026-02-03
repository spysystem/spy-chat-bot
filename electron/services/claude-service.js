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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaudeService = void 0;
var sdk_1 = require("@anthropic-ai/sdk");
var electron_1 = require("electron");
var fs = require("fs/promises");
var path = require("path");
var vector_store_service_1 = require("./vector-store-service");
var ClaudeService = /** @class */ (function () {
    function ClaudeService() {
        this.client = null;
        this.vectorStore = null;
        this.apiKeyPath = path.join(electron_1.app.getPath('userData'), 'claude-api-key.txt');
    }
    ClaudeService.prototype.ensureVectorStore = function () {
        return __awaiter(this, void 0, void 0, function () {
            var apiKey, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (this.vectorStore) {
                            return [2 /*return*/, this.vectorStore];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, this.getApiKey()];
                    case 2:
                        apiKey = _a.sent();
                        if (!apiKey) {
                            return [2 /*return*/, null];
                        }
                        this.vectorStore = new vector_store_service_1.VectorStoreService(apiKey);
                        return [4 /*yield*/, this.vectorStore.initialize()];
                    case 3:
                        _a.sent();
                        return [2 /*return*/, this.vectorStore];
                    case 4:
                        error_1 = _a.sent();
                        console.error('Error initializing vector store:', error_1);
                        return [2 /*return*/, null];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    ClaudeService.prototype.getApiKey = function () {
        return __awaiter(this, void 0, void 0, function () {
            var key, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, fs.readFile(this.apiKeyPath, 'utf-8')];
                    case 1:
                        key = _a.sent();
                        return [2 /*return*/, key.trim()];
                    case 2:
                        error_2 = _a.sent();
                        return [2 /*return*/, null];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    ClaudeService.prototype.saveApiKey = function (apiKey) {
        return __awaiter(this, void 0, void 0, function () {
            var trimmedKey, error_3;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        trimmedKey = apiKey.trim();
                        if (!trimmedKey.startsWith('sk-ant-')) {
                            throw new Error('Invalid API key format. Must start with "sk-ant-"');
                        }
                        return [4 /*yield*/, fs.writeFile(this.apiKeyPath, trimmedKey, 'utf-8')];
                    case 1:
                        _a.sent();
                        this.client = new sdk_1.default({ apiKey: trimmedKey });
                        return [3 /*break*/, 3];
                    case 2:
                        error_3 = _a.sent();
                        throw error_3;
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    ClaudeService.prototype.ensureClient = function () {
        return __awaiter(this, void 0, void 0, function () {
            var apiKey;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (this.client) {
                            return [2 /*return*/, this.client];
                        }
                        return [4 /*yield*/, this.getApiKey()];
                    case 1:
                        apiKey = _a.sent();
                        if (!apiKey) {
                            throw new Error('Claude API key not configured');
                        }
                        this.client = new sdk_1.default({ apiKey: apiKey });
                        return [2 /*return*/, this.client];
                }
            });
        });
    };
    ClaudeService.prototype.escapeCsvValue = function (value) {
        // Escape CSV values: wrap in quotes if contains comma, quote, or newline
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
            return "\"".concat(value.replace(/"/g, '""'), "\"");
        }
        return value;
    };
    ClaudeService.prototype.exportToCsv = function (filename, data) {
        return __awaiter(this, void 0, void 0, function () {
            var headers, csvRows, _loop_1, _i, data_1, row, csvContent, downloadsPath, filePath;
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (data.length === 0) {
                            return [2 /*return*/, { error: 'No data to export' }];
                        }
                        headers = Object.keys(data[0]);
                        csvRows = [];
                        // Add header row
                        csvRows.push(headers.map(function (h) { return _this.escapeCsvValue(h); }).join(','));
                        _loop_1 = function (row) {
                            var values = headers.map(function (h) { var _a; return _this.escapeCsvValue(String((_a = row[h]) !== null && _a !== void 0 ? _a : '')); });
                            csvRows.push(values.join(','));
                        };
                        // Add data rows
                        for (_i = 0, data_1 = data; _i < data_1.length; _i++) {
                            row = data_1[_i];
                            _loop_1(row);
                        }
                        csvContent = csvRows.join('\n');
                        downloadsPath = electron_1.app.getPath('downloads');
                        filePath = path.join(downloadsPath, filename);
                        return [4 /*yield*/, fs.writeFile(filePath, csvContent, 'utf-8')];
                    case 1:
                        _a.sent();
                        return [2 /*return*/, {
                                success: true,
                                filePath: filePath,
                                rowCount: data.length,
                                message: "CSV file saved to Downloads folder: ".concat(filename),
                            }];
                }
            });
        });
    };
    ClaudeService.prototype.sendMessage = function (userMessage, databaseIds, databaseService, githubService, onProgress, conversationHistory, databaseName, onDebugLog) {
        return __awaiter(this, void 0, void 0, function () {
            var dbServerHost, configs, config, client, tools, githubConfig, hasGitHub, _loop_2, _i, databaseIds_1, dbId, messages, _a, conversationHistory_1, msg, contextDocuments, vectorStore, searchQuery, recentUserMessages, relevantDocs, error_4, systemPrompt, serverDisplayName, response, thinkingBlocks, iterations, maxIterations, queryResults, toolResults, toolCount, currentTool, _loop_3, this_1, _b, _c, content, exportKeywords, isExportRequest, largestResult, now, dateStr, timeStr, filename, currentText, error_5, simplificationMessages, _d, conversationHistory_2, msg, technicalAnswer, answerResponse, answer, simplifiedResponse;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        dbServerHost = '';
                        if (!(databaseIds.length > 0)) return [3 /*break*/, 2];
                        return [4 /*yield*/, databaseService.getConfigs()];
                    case 1:
                        configs = _e.sent();
                        config = configs.find(function (c) { return c.id === databaseIds[0]; });
                        if (config) {
                            dbServerHost = config.host;
                        }
                        _e.label = 2;
                    case 2: return [4 /*yield*/, this.ensureClient()];
                    case 3:
                        client = _e.sent();
                        onProgress === null || onProgress === void 0 ? void 0 : onProgress('Preparing tools...');
                        tools = [];
                        return [4 /*yield*/, githubService.getConfig()];
                    case 4:
                        githubConfig = _e.sent();
                        hasGitHub = !!githubConfig;
                        if (githubConfig) {
                            console.log('[ClaudeService] GitHub repo:', "".concat(githubConfig.owner, "/").concat(githubConfig.repo, "@").concat(githubConfig.branch));
                        }
                        if (!(databaseName && databaseIds.length > 0)) return [3 /*break*/, 9];
                        _loop_2 = function (dbId) {
                            var configs, config, dbDisplayName, toolSuffix;
                            return __generator(this, function (_f) {
                                switch (_f.label) {
                                    case 0: return [4 /*yield*/, databaseService.getConfigs()];
                                    case 1:
                                        configs = _f.sent();
                                        config = configs.find(function (c) { return c.id === dbId; });
                                        if (config) {
                                            dbDisplayName = databaseName || config.database || config.name;
                                            toolSuffix = config.name.toLowerCase().replace(/\s+/g, '_');
                                            tools.push({
                                                name: "query_".concat(toolSuffix),
                                                description: "Execute a READ-ONLY SQL query on database: ".concat(dbDisplayName, ". ONLY SELECT, SHOW, DESCRIBE, and EXPLAIN queries are allowed. Write operations (INSERT, UPDATE, DELETE, etc.) are NEVER permitted."),
                                                input_schema: {
                                                    type: 'object',
                                                    properties: {
                                                        query: {
                                                            type: 'string',
                                                            description: 'The SQL SELECT query to execute (read-only)',
                                                        },
                                                    },
                                                    required: ['query'],
                                                },
                                            });
                                            tools.push({
                                                name: "list_tables_".concat(toolSuffix),
                                                description: "List all tables in database: ".concat(dbDisplayName),
                                                input_schema: {
                                                    type: 'object',
                                                    properties: {},
                                                },
                                            });
                                            tools.push({
                                                name: "describe_table_".concat(toolSuffix),
                                                description: "Get schema information for a table in database: ".concat(dbDisplayName),
                                                input_schema: {
                                                    type: 'object',
                                                    properties: {
                                                        table_name: {
                                                            type: 'string',
                                                            description: 'Name of the table to describe',
                                                        },
                                                    },
                                                    required: ['table_name'],
                                                },
                                            });
                                        }
                                        return [2 /*return*/];
                                }
                            });
                        };
                        _i = 0, databaseIds_1 = databaseIds;
                        _e.label = 5;
                    case 5:
                        if (!(_i < databaseIds_1.length)) return [3 /*break*/, 8];
                        dbId = databaseIds_1[_i];
                        return [5 /*yield**/, _loop_2(dbId)];
                    case 6:
                        _e.sent();
                        _e.label = 7;
                    case 7:
                        _i++;
                        return [3 /*break*/, 5];
                    case 8:
                        // Add CSV export tool if database is connected
                        tools.push({
                            name: 'export_to_csv',
                            description: 'Export query results to a CSV file in the Downloads folder. ALWAYS use this tool when user asks for: "list", "liste", "export", "eksporter", "udtræk", "oversigt", "extract", "overview" or similar data extraction requests. The file will be automatically saved with a timestamp.',
                            input_schema: {
                                type: 'object',
                                properties: {
                                    query: {
                                        type: 'string',
                                        description: 'The SQL SELECT query to execute and export',
                                    },
                                    filename: {
                                        type: 'string',
                                        description: 'Name for the CSV file (without extension)',
                                    },
                                },
                                required: ['query', 'filename'],
                            },
                        });
                        _e.label = 9;
                    case 9:
                        // Add GitHub tools if configured
                        if (hasGitHub && githubConfig) {
                            tools.push({
                                name: 'search_code',
                                description: "Search for code in the ".concat(githubConfig.owner, "/").concat(githubConfig.repo, " repository"),
                                input_schema: {
                                    type: 'object',
                                    properties: {
                                        query: {
                                            type: 'string',
                                            description: 'Search query (e.g., "function calculatePrice", "class Customer")',
                                        },
                                    },
                                    required: ['query'],
                                },
                            });
                            tools.push({
                                name: 'read_file',
                                description: "Read the contents of a file from the ".concat(githubConfig.owner, "/").concat(githubConfig.repo, " repository"),
                                input_schema: {
                                    type: 'object',
                                    properties: {
                                        file_path: {
                                            type: 'string',
                                            description: 'Path to the file (e.g., "src/components/ChatView.tsx")',
                                        },
                                    },
                                    required: ['file_path'],
                                },
                            });
                            tools.push({
                                name: 'list_files',
                                description: "List files in a directory from the ".concat(githubConfig.owner, "/").concat(githubConfig.repo, " repository"),
                                input_schema: {
                                    type: 'object',
                                    properties: {
                                        directory_path: {
                                            type: 'string',
                                            description: 'Path to the directory (empty string for root)',
                                        },
                                    },
                                    required: ['directory_path'],
                                },
                            });
                            tools.push({
                                name: 'get_repository_structure',
                                description: "Get the complete file tree structure of the ".concat(githubConfig.owner, "/").concat(githubConfig.repo, " repository"),
                                input_schema: {
                                    type: 'object',
                                    properties: {},
                                },
                            });
                        }
                        messages = [];
                        if (conversationHistory && conversationHistory.length > 0) {
                            // Add all previous messages
                            for (_a = 0, conversationHistory_1 = conversationHistory; _a < conversationHistory_1.length; _a++) {
                                msg = conversationHistory_1[_a];
                                messages.push({
                                    role: msg.role,
                                    content: msg.content,
                                });
                            }
                        }
                        // Add the new user message
                        messages.push({
                            role: 'user',
                            content: userMessage,
                        });
                        onProgress === null || onProgress === void 0 ? void 0 : onProgress('Searching knowledge base...');
                        contextDocuments = [];
                        _e.label = 10;
                    case 10:
                        _e.trys.push([10, 14, , 15]);
                        return [4 /*yield*/, this.ensureVectorStore()];
                    case 11:
                        vectorStore = _e.sent();
                        if (!vectorStore) return [3 /*break*/, 13];
                        searchQuery = userMessage;
                        if (conversationHistory && conversationHistory.length > 0) {
                            recentUserMessages = conversationHistory
                                .filter(function (msg) { return msg.role === 'user'; })
                                .slice(-2) // Last 2 user messages
                                .map(function (msg) { return msg.content; });
                            if (recentUserMessages.length > 0) {
                                searchQuery = __spreadArray(__spreadArray([], recentUserMessages, true), [userMessage], false).join(' ');
                                onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('info', 'Vector Store', "Searching with conversation context (".concat(recentUserMessages.length, " previous messages)"));
                            }
                        }
                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('info', 'Vector Store', "Searching for relevant context for query: \"".concat(userMessage.substring(0, 100)).concat(userMessage.length > 100 ? '...' : '', "\""));
                        return [4 /*yield*/, vectorStore.search(searchQuery, 3)];
                    case 12:
                        relevantDocs = _e.sent();
                        contextDocuments = relevantDocs.map(function (doc) { return doc.text; });
                        // Log each found document
                        if (relevantDocs.length > 0) {
                            onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('info', 'Vector Store', "Found ".concat(relevantDocs.length, " relevant documents:"));
                            relevantDocs.forEach(function (doc, index) {
                                var preview = doc.text.length > 150 ? doc.text.substring(0, 150) + '...' : doc.text;
                                onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('info', 'Vector Store', "  [".concat(index + 1, "] ").concat(doc.id, ": ").concat(preview));
                            });
                        }
                        else {
                            onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('info', 'Vector Store', 'No relevant documents found');
                        }
                        _e.label = 13;
                    case 13: return [3 /*break*/, 15];
                    case 14:
                        error_4 = _e.sent();
                        console.error('Error searching vector store:', error_4);
                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('error', 'Vector Store', 'Error searching for context', String(error_4));
                        return [3 /*break*/, 15];
                    case 15:
                        onProgress === null || onProgress === void 0 ? void 0 : onProgress('Sending message to Jørgen...');
                        systemPrompt = "You are a helpful assistant that answers questions accurately and clearly. ALWAYS respond in the same language as the user's question.\n\nTHINKING PROCESS:\nBefore using any tools, use <thinking> tags to plan your approach:\n- What information do I need to answer this question?\n- Do I need to query the database, or can I answer from existing knowledge?\n- Do I need to look at code files, or is this a data question?\n- What's the most efficient way to get the answer?\n\nUse your thinking to avoid unnecessary work - don't query the database if you can answer from context, and don't search code if you just need data.";
                        // Add relevant context from vector store
                        if (contextDocuments.length > 0) {
                            systemPrompt += '\n\nRELEVANT SYSTEM KNOWLEDGE:\n';
                            contextDocuments.forEach(function (doc, index) {
                                systemPrompt += "\n".concat(index + 1, ". ").concat(doc);
                            });
                            systemPrompt += '\n\nUse this knowledge to help answer the user\'s question when relevant.';
                            onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('info', 'Vector Store', "Added ".concat(contextDocuments.length, " documents to system prompt"));
                        }
                        if (databaseName && databaseIds.length > 0) {
                            serverDisplayName = dbServerHost.replace('.spysystem.dk', '');
                            systemPrompt += "\n\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nSYSTEM CONTEXT\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\nYou are connected to the SPY System - a comprehensive warehouse management and e-commerce platform built with PHP 8.1 backend and React 19 frontend.\n\nCURRENT CONNECTION:\n- Database: ".concat(databaseName, "\n- Server: ").concat(serverDisplayName, " (").concat(dbServerHost, ")\n- System: SPY Systemet\n- Backend: PHP 8.1 with 100+ spysystem packages\n- Frontend: React 19 with TypeScript\n\nSYSTEM CAPABILITIES:\nThe SPY system handles:\n- Order processing and fulfillment\n- Inventory management across multiple warehouses\n- Shipping integrations (DHL, UPS, FedEx, GLS, PostNord, Bring, etc.)\n- E-commerce platforms (Shopify, WooCommerce, Sitoo)\n- B2B operations and customer portals\n- Financial tracking and accounting integrations\n- EDI communication (ORDERS, DESADV, INVOIC)\n- Multi-brand and multi-market support\n\nKEY ARCHITECTURE NOTES:\n- Entity-based ORM with EntityWrapper base class\n- Hungarian notation (iID, strName, bActive, fPrice, arrData, oObject)\n- No NULL values allowed - use 0 for \"not set\" integers, empty string for text\n- All tables have audit fields (added_user_id, added_date, changed_user_id, changed_date)\n- Collections are immutable - use withX() methods\n- Prepared statements with named parameters required for all queries\n\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nDATABASE SECURITY & QUERY RULES\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\nCRITICAL SECURITY REQUIREMENT:\nAll database operations are READ-ONLY. You can ONLY execute SELECT, SHOW, DESCRIBE, and EXPLAIN queries.\nNEVER attempt INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, or any other write operations.\nAny attempt to write to the database will be blocked and result in an error.\nWrite operations are NEVER permitted under any circumstances.\n\nIMPORTANT QUERY RULES:\n1. NEVER query from views that start with \"bi_\" (e.g., bi_orders, bi_customers, bi_sales)\n   - These are BI/analytics views and should be avoided\n   - Always use the actual database tables directly instead of BI views\n   - If you see a table name starting with \"bi_\", ignore it and find the equivalent regular table\n\n2. Common table patterns in SPY system:\n   - customer: Customer data\n   - orders: Order headers\n   - orders_lines: Order line items\n   - style: Product styles/SKUs\n   - assortment: Product assortments/collections\n   - packing: Warehouse packing operations\n   - shipping: Shipping/delivery information\n   - brand: Brand information\n   - season: Season definitions\n\n3. Always check table structure with describe_table before querying\n4. Use LIMIT when querying large tables to avoid timeouts\n5. Join tables explicitly - avoid implicit joins\n\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nCSV EXPORT TOOL\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\nWhen the user asks for a \"list\", \"extract\", \"export\", \"udtr\u00E6k\", \"liste\", \"oversigt\" or similar request for data:\n\n1. Use the export_to_csv tool to automatically create a CSV file in the Downloads folder\n2. Choose a descriptive filename that reflects the data:\n   - Good examples: \"style_assortments_ean\", \"customer_orders_january\", \"inventory_status\"\n   - Bad examples: \"data\", \"export\", \"results\"\n3. The filename should NOT include .csv extension (it's added automatically)\n4. After the CSV is created, tell the user exactly where the file was saved:\n   \"I have created a CSV file in your Downloads folder: [filename].csv with [X] rows\"\n5. NEVER claim files are saved to Desktop or any other location - they are ALWAYS in the Downloads folder\n\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nOUTPUT RULES\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n1. **Summary First**: Start with a summary sentence before any details',\n2. **Group Related Data**: When showing multiple items, group them logically',\n3. **Use Sections with Headers**: Separate different types of data with clear headers',\n4. **Tables for Structured Data**: Use markdown tables for lists of items with multiple attributes',\n5. **Key Metrics Highlighted**: Put important numbers/totals in **bold**',\n");
                        }
                        // First, let Claude research and gather information without restrictions
                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('api', 'Claude API', "Sending initial message: \"".concat(userMessage.substring(0, 100)).concat(userMessage.length > 100 ? '...' : '', "\""));
                        if (conversationHistory && conversationHistory.length > 0) {
                            onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('api', 'Claude API', "Including ".concat(conversationHistory.length, " messages from conversation history"));
                        }
                        if (contextDocuments.length > 0) {
                            onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('api', 'Claude API', "Including ".concat(contextDocuments.length, " vector store documents in system prompt"));
                        }
                        return [4 /*yield*/, client.messages.create({
                                model: 'claude-sonnet-4-5-20250929',
                                max_tokens: 4096,
                                system: systemPrompt,
                                tools: tools,
                                messages: messages,
                                thinking: {
                                    type: 'enabled',
                                    budget_tokens: 2000,
                                },
                            })];
                    case 16:
                        response = _e.sent();
                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('api', 'Claude API', "Response received - stop_reason: ".concat(response.stop_reason));
                        thinkingBlocks = response.content.filter(function (c) { return c.type === 'thinking'; });
                        if (thinkingBlocks.length > 0) {
                            thinkingBlocks.forEach(function (thinking, index) {
                                onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('info', 'Claude Thinking', "Thought process ".concat(index + 1, ":"), thinking.thinking);
                            });
                        }
                        onProgress === null || onProgress === void 0 ? void 0 : onProgress('Processing response...');
                        iterations = 0;
                        maxIterations = 10;
                        queryResults = [];
                        _e.label = 17;
                    case 17:
                        if (!(response.stop_reason === 'tool_use' && iterations < maxIterations)) return [3 /*break*/, 23];
                        iterations++;
                        toolResults = [];
                        toolCount = response.content.filter(function (c) { return c.type === 'tool_use'; }).length;
                        currentTool = 0;
                        _loop_3 = function (content) {
                            var toolName_1, toolInput, result, query, filePath, dirPath, query, filename, configs, config, queryResult, queryResultObj, now, dateStr, timeStr, fullFilename, configs, config, query, shortQuery, queryResultObj, configs, config, configs, config, tableName, error_6, errorMessage;
                            return __generator(this, function (_g) {
                                switch (_g.label) {
                                    case 0:
                                        if (!(content.type === 'tool_use')) return [3 /*break*/, 24];
                                        currentTool++;
                                        toolName_1 = content.name;
                                        toolInput = content.input;
                                        _g.label = 1;
                                    case 1:
                                        _g.trys.push([1, 23, , 24]);
                                        result = void 0;
                                        if (!(toolName_1 === 'search_code')) return [3 /*break*/, 3];
                                        query = toolInput.query;
                                        onProgress === null || onProgress === void 0 ? void 0 : onProgress("Searching code: ".concat(query.substring(0, 40), "... (").concat(currentTool, "/").concat(toolCount, ")"));
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('tool', 'GitHub', "Searching code: ".concat(query), "Tool: ".concat(toolName_1, "\nQuery: ").concat(query));
                                        return [4 /*yield*/, githubService.searchCode(query)];
                                    case 2:
                                        result = _g.sent();
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('tool', 'GitHub', "Search completed - found ".concat(result.length || 0, " results"));
                                        return [3 /*break*/, 22];
                                    case 3:
                                        if (!(toolName_1 === 'read_file')) return [3 /*break*/, 5];
                                        filePath = toolInput.file_path;
                                        onProgress === null || onProgress === void 0 ? void 0 : onProgress("Reading file: ".concat(filePath, " (").concat(currentTool, "/").concat(toolCount, ")"));
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('tool', 'GitHub', "Reading file: ".concat(filePath), "Tool: ".concat(toolName_1, "\nFile: ").concat(filePath));
                                        return [4 /*yield*/, githubService.getFileContent(filePath)];
                                    case 4:
                                        result = _g.sent();
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('tool', 'GitHub', "File read successfully: ".concat(filePath));
                                        return [3 /*break*/, 22];
                                    case 5:
                                        if (!(toolName_1 === 'list_files')) return [3 /*break*/, 7];
                                        dirPath = toolInput.directory_path;
                                        onProgress === null || onProgress === void 0 ? void 0 : onProgress("Listing files in: ".concat(dirPath || '/', " (").concat(currentTool, "/").concat(toolCount, ")"));
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('tool', 'GitHub', "Listing files in: ".concat(dirPath || '/'), "Tool: ".concat(toolName_1, "\nDirectory: ").concat(dirPath));
                                        return [4 /*yield*/, githubService.listFiles(dirPath)];
                                    case 6:
                                        result = _g.sent();
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('tool', 'GitHub', "Listed ".concat(result.length || 0, " files"));
                                        return [3 /*break*/, 22];
                                    case 7:
                                        if (!(toolName_1 === 'get_repository_structure')) return [3 /*break*/, 9];
                                        onProgress === null || onProgress === void 0 ? void 0 : onProgress("Getting repository structure (".concat(currentTool, "/").concat(toolCount, ")"));
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('tool', 'GitHub', "Getting repository structure", "Tool: ".concat(toolName_1));
                                        return [4 /*yield*/, githubService.getTree(true)];
                                    case 8:
                                        result = _g.sent();
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('tool', 'GitHub', "Repository structure retrieved");
                                        return [3 /*break*/, 22];
                                    case 9:
                                        if (!(toolName_1 === 'export_to_csv')) return [3 /*break*/, 13];
                                        query = toolInput.query;
                                        filename = toolInput.filename;
                                        return [4 /*yield*/, databaseService.getConfigs()];
                                    case 10:
                                        configs = _g.sent();
                                        config = configs.find(function (c) { return c.id === databaseIds[0]; });
                                        if (!config) {
                                            throw new Error('Database config not found for CSV export');
                                        }
                                        onProgress === null || onProgress === void 0 ? void 0 : onProgress("Exporting to CSV: ".concat(filename, ".csv (").concat(currentTool, "/").concat(toolCount, ")"));
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('tool', 'CSV Export', "Exporting query results to ".concat(filename, ".csv"), query);
                                        return [4 /*yield*/, databaseService.executeQuery(config.id, query, databaseName)];
                                    case 11:
                                        queryResult = _g.sent();
                                        queryResultObj = queryResult;
                                        if (!queryResultObj.rows || queryResultObj.rows.length === 0) {
                                            throw new Error('Query returned no data to export');
                                        }
                                        now = new Date();
                                        dateStr = now.toISOString().split('T')[0];
                                        timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
                                        fullFilename = "".concat(filename, "_").concat(dateStr, "_").concat(timeStr, ".csv");
                                        return [4 /*yield*/, this_1.exportToCsv(fullFilename, queryResultObj.rows)];
                                    case 12:
                                        // Export to CSV
                                        result = _g.sent();
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('tool', 'CSV Export', "Successfully exported ".concat(queryResultObj.rows.length, " rows to ").concat(fullFilename));
                                        return [3 /*break*/, 22];
                                    case 13:
                                        if (!toolName_1.startsWith('query_')) return [3 /*break*/, 16];
                                        return [4 /*yield*/, databaseService.getConfigs()];
                                    case 14:
                                        configs = _g.sent();
                                        config = configs.find(function (c) {
                                            var dbName = c.name.toLowerCase().replace(/\s+/g, '_');
                                            return toolName_1.includes(dbName);
                                        });
                                        if (!config) {
                                            throw new Error("Database config not found for tool: ".concat(toolName_1));
                                        }
                                        query = toolInput.query;
                                        shortQuery = query.length > 60
                                            ? query.substring(0, 60) + '...'
                                            : query;
                                        onProgress === null || onProgress === void 0 ? void 0 : onProgress("Running query (".concat(currentTool, "/").concat(toolCount, "): ").concat(shortQuery));
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('query', 'Database Query', "Executing query on ".concat(databaseName), query);
                                        return [4 /*yield*/, databaseService.executeQuery(config.id, query, databaseName)];
                                    case 15:
                                        result = _g.sent();
                                        queryResultObj = result;
                                        if (queryResultObj.rows && queryResultObj.rows.length > 0) {
                                            queryResults.push({ query: query, data: queryResultObj.rows });
                                        }
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('query', 'Database Query', "Query completed - ".concat(queryResultObj.rowCount || 0, " rows returned"));
                                        return [3 /*break*/, 22];
                                    case 16:
                                        if (!toolName_1.startsWith('list_tables_')) return [3 /*break*/, 19];
                                        return [4 /*yield*/, databaseService.getConfigs()];
                                    case 17:
                                        configs = _g.sent();
                                        config = configs.find(function (c) {
                                            var dbName = c.name.toLowerCase().replace(/\s+/g, '_');
                                            return toolName_1.includes(dbName);
                                        });
                                        if (!config) {
                                            throw new Error("Database config not found for tool: ".concat(toolName_1));
                                        }
                                        onProgress === null || onProgress === void 0 ? void 0 : onProgress("Listing tables in ".concat(config.name, " (").concat(currentTool, "/").concat(toolCount, ")"));
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('query', 'Database Schema', "Listing tables in ".concat(databaseName), "SHOW TABLES");
                                        return [4 /*yield*/, databaseService.listTables(config.id, databaseName)];
                                    case 18:
                                        result = _g.sent();
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('query', 'Database Schema', "Found ".concat(result.length, " tables"));
                                        return [3 /*break*/, 22];
                                    case 19:
                                        if (!toolName_1.startsWith('describe_table_')) return [3 /*break*/, 22];
                                        return [4 /*yield*/, databaseService.getConfigs()];
                                    case 20:
                                        configs = _g.sent();
                                        config = configs.find(function (c) {
                                            var dbName = c.name.toLowerCase().replace(/\s+/g, '_');
                                            return toolName_1.includes(dbName);
                                        });
                                        if (!config) {
                                            throw new Error("Database config not found for tool: ".concat(toolName_1));
                                        }
                                        tableName = toolInput.table_name;
                                        onProgress === null || onProgress === void 0 ? void 0 : onProgress("Describing table: ".concat(tableName, " (").concat(currentTool, "/").concat(toolCount, ")"));
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('query', 'Database Schema', "Describing table: ".concat(tableName), "DESCRIBE ".concat(tableName));
                                        return [4 /*yield*/, databaseService.getTableSchema(config.id, tableName, databaseName)];
                                    case 21:
                                        result = _g.sent();
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('query', 'Database Schema', "Table schema retrieved for ".concat(tableName));
                                        _g.label = 22;
                                    case 22:
                                        toolResults.push({
                                            type: 'tool_result',
                                            tool_use_id: content.id,
                                            content: JSON.stringify(result, null, 2),
                                        });
                                        return [3 /*break*/, 24];
                                    case 23:
                                        error_6 = _g.sent();
                                        errorMessage = error_6 instanceof Error ? error_6.message : 'Unknown error';
                                        onDebugLog === null || onDebugLog === void 0 ? void 0 : onDebugLog('error', 'Tool Error', "Error in ".concat(toolName_1, ": ").concat(errorMessage), JSON.stringify(toolInput, null, 2));
                                        toolResults.push({
                                            type: 'tool_result',
                                            tool_use_id: content.id,
                                            content: "Error: ".concat(errorMessage),
                                            is_error: true,
                                        });
                                        return [3 /*break*/, 24];
                                    case 24: return [2 /*return*/];
                                }
                            });
                        };
                        this_1 = this;
                        _b = 0, _c = response.content;
                        _e.label = 18;
                    case 18:
                        if (!(_b < _c.length)) return [3 /*break*/, 21];
                        content = _c[_b];
                        return [5 /*yield**/, _loop_3(content)];
                    case 19:
                        _e.sent();
                        _e.label = 20;
                    case 20:
                        _b++;
                        return [3 /*break*/, 18];
                    case 21:
                        // Add assistant response and tool results to messages
                        messages.push({
                            role: 'assistant',
                            content: response.content,
                        });
                        messages.push({
                            role: 'user',
                            content: toolResults,
                        });
                        // Get next response
                        onProgress === null || onProgress === void 0 ? void 0 : onProgress('Jørgen is thinking...');
                        return [4 /*yield*/, client.messages.create({
                                model: 'claude-sonnet-4-5-20250929',
                                max_tokens: 4096,
                                system: systemPrompt,
                                tools: tools,
                                messages: messages,
                                thinking: {
                                    type: 'enabled',
                                    budget_tokens: 2000,
                                },
                            })];
                    case 22:
                        response = _e.sent();
                        onProgress === null || onProgress === void 0 ? void 0 : onProgress('Processing response...');
                        return [3 /*break*/, 17];
                    case 23:
                        exportKeywords = ['list', 'liste', 'udtræk', 'export', 'eksporter', 'overview', 'oversigt'];
                        isExportRequest = exportKeywords.some(function (keyword) { return userMessage.toLowerCase().includes(keyword); });
                        if (!(isExportRequest && queryResults.length > 0)) return [3 /*break*/, 28];
                        largestResult = queryResults.reduce(function (prev, current) {
                            return (current.data.length > prev.data.length) ? current : prev;
                        });
                        if (!(largestResult.data.length >= 10)) return [3 /*break*/, 28];
                        onProgress === null || onProgress === void 0 ? void 0 : onProgress("Auto-generating CSV export with ".concat(largestResult.data.length, " rows..."));
                        now = new Date();
                        dateStr = now.toISOString().split('T')[0];
                        timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
                        filename = "export_".concat(dateStr, "_").concat(timeStr, ".csv");
                        _e.label = 24;
                    case 24:
                        _e.trys.push([24, 27, , 28]);
                        return [4 /*yield*/, this.exportToCsv(filename, largestResult.data)];
                    case 25:
                        _e.sent();
                        currentText = response.content
                            .filter(function (c) { return c.type === 'text'; })
                            .map(function (c) { return c.text; })
                            .join('\n');
                        // Add CSV info to the messages
                        messages.push({
                            role: 'assistant',
                            content: currentText,
                        });
                        messages.push({
                            role: 'user',
                            content: "A CSV file has been automatically created: ".concat(filename, " with ").concat(largestResult.data.length, " rows saved to the Downloads folder. Include this information in your answer."),
                        });
                        return [4 /*yield*/, client.messages.create({
                                model: 'claude-sonnet-4-5-20250929',
                                max_tokens: 4096,
                                messages: messages,
                            })];
                    case 26:
                        // Get updated response that includes CSV info
                        response = _e.sent();
                        return [3 /*break*/, 28];
                    case 27:
                        error_5 = _e.sent();
                        console.error('[ClaudeService] Failed to auto-export CSV:', error_5);
                        return [3 /*break*/, 28];
                    case 28:
                        onProgress === null || onProgress === void 0 ? void 0 : onProgress('Finishing answer...');
                        simplificationMessages = [];
                        // Only add the conversation history (without tool blocks)
                        if (conversationHistory && conversationHistory.length > 0) {
                            for (_d = 0, conversationHistory_2 = conversationHistory; _d < conversationHistory_2.length; _d++) {
                                msg = conversationHistory_2[_d];
                                simplificationMessages.push({
                                    role: msg.role,
                                    content: msg.content,
                                });
                            }
                        }
                        // Add the user's question
                        simplificationMessages.push({
                            role: 'user',
                            content: userMessage,
                        });
                        technicalAnswer = response.content
                            .filter(function (c) { return c.type === 'text'; })
                            .map(function (c) { return c.text; })
                            .join('\n');
                        if (!technicalAnswer.trim()) return [3 /*break*/, 29];
                        simplificationMessages.push({
                            role: 'assistant',
                            content: technicalAnswer,
                        });
                        return [3 /*break*/, 31];
                    case 29:
                        // If Claude didn't provide a text response (only used tools), ask for an answer first
                        // Use the FULL messages array (with tool results) to get a complete answer
                        messages.push({
                            role: 'user',
                            content: 'Please provide a complete answer in the SAME LANGUAGE as the original question, based on all the data you gathered from the database queries.',
                        });
                        return [4 /*yield*/, client.messages.create({
                                model: 'claude-sonnet-4-5-20250929',
                                max_tokens: 4096,
                                system: systemPrompt,
                                messages: messages,
                            })];
                    case 30:
                        answerResponse = _e.sent();
                        answer = answerResponse.content
                            .filter(function (c) { return c.type === 'text'; })
                            .map(function (c) { return c.text; })
                            .join('\n');
                        simplificationMessages.push({
                            role: 'assistant',
                            content: answer,
                        });
                        _e.label = 31;
                    case 31:
                        // Ask Claude to rewrite it in simple language for support staff
                        simplificationMessages.push({
                            role: 'user',
                            content: "Now rewrite your answer for non-technical customer support staff who have never programmed.\n\nCRITICAL: Answer in the SAME LANGUAGE as the original question. If the question was in Danish, answer in Danish. If it was in English, answer in English.\n\n\nRequirements:\n- Use only everyday business language (customer, order, discount, price, invoice, delivery, etc.)\n- Explain WHAT happens, not HOW the system implements it\n- No code snippets, SQL queries, or technical terms\n- No file names, variable names, or implementation details\n- Write like you're explaining to someone who helps customers but doesn't know programming\n- If you created a CSV file, mention where it was saved\n\nKeep the same information and accuracy, just express it in simple, clear business terms in the SAME LANGUAGE as the question.",
                        });
                        return [4 /*yield*/, client.messages.create({
                                model: 'claude-sonnet-4-5-20250929',
                                max_tokens: 4096,
                                messages: simplificationMessages,
                            })];
                    case 32:
                        simplifiedResponse = _e.sent();
                        onProgress === null || onProgress === void 0 ? void 0 : onProgress('Finalizing answer...');
                        // Extract and return the simplified answer
                        return [2 /*return*/, simplifiedResponse.content
                                .filter(function (c) { return c.type === 'text'; })
                                .map(function (c) { return c.text; })
                                .join('\n')];
                }
            });
        });
    };
    ClaudeService.prototype.generateTldr = function (messageContent) {
        return __awaiter(this, void 0, void 0, function () {
            var client, response;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.ensureClient()];
                    case 1:
                        client = _a.sent();
                        return [4 /*yield*/, client.messages.create({
                                model: 'claude-sonnet-4-5-20250929',
                                max_tokens: 1024,
                                messages: [
                                    {
                                        role: 'user',
                                        content: "Please provide a very short TL;DR (Too Long; Didn't Read) summary of this answer in 2-3 sentences maximum. Keep it in the SAME LANGUAGE as the original text. Focus on the key points only.\n\nOriginal answer:\n".concat(messageContent),
                                    },
                                ],
                            })];
                    case 2:
                        response = _a.sent();
                        return [2 /*return*/, response.content
                                .filter(function (c) { return c.type === 'text'; })
                                .map(function (c) { return c.text; })
                                .join('\n')];
                }
            });
        });
    };
    return ClaudeService;
}());
exports.ClaudeService = ClaudeService;
