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
exports.DatabaseService = void 0;
var mysql = require("mysql2/promise");
var fs = require("fs/promises");
var path = require("path");
var electron_1 = require("electron");
/**
 * DatabaseService - CRITICAL SECURITY: READ-ONLY ENFORCED
 *
 * This service implements MULTIPLE LAYERS of security to make it PHYSICALLY IMPOSSIBLE to write to databases:
 *
 * Layer 1: Query Whitelist - Only SELECT, SHOW, DESCRIBE, EXPLAIN allowed
 * Layer 2: Keyword Blacklist - Blocks ALL write operations (INSERT, UPDATE, DELETE, etc.)
 * Layer 3: Multiple Statement Protection - Prevents SQL injection via semicolons
 * Layer 4: MySQL Session Read-Only - Forces MySQL to reject any write attempts at the database level
 * Layer 5: Read-Only Transaction - Starts all connections in read-only transaction mode
 *
 * Even if all application-level checks are bypassed, the MySQL server itself will reject write operations.
 */
var DatabaseService = /** @class */ (function () {
    function DatabaseService() {
        this.connections = new Map();
        this.configPath = path.join(electron_1.app.getPath('userData'), 'database-configs.json');
        this.queryLogPath = path.join(electron_1.app.getPath('userData'), 'query-log.txt');
    }
    DatabaseService.prototype.logQuery = function (query, databaseName, configId, success, error, rowCount) {
        return __awaiter(this, void 0, void 0, function () {
            var timestamp, logEntry, logError_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        timestamp = new Date().toISOString();
                        logEntry = [
                            '═'.repeat(80),
                            "[".concat(timestamp, "]"),
                            "Database: ".concat(databaseName || 'N/A'),
                            "Config ID: ".concat(configId),
                            "Status: ".concat(success ? 'SUCCESS' : 'FAILED'),
                            '',
                            'Query:',
                            query,
                            '',
                        ];
                        if (success && rowCount !== undefined) {
                            logEntry.push("Result: ".concat(rowCount, " rows returned"));
                        }
                        else if (error) {
                            logEntry.push("Error: ".concat(error));
                        }
                        logEntry.push(''); // Empty line at the end
                        return [4 /*yield*/, fs.appendFile(this.queryLogPath, logEntry.join('\n'))];
                    case 1:
                        _a.sent();
                        return [3 /*break*/, 3];
                    case 2:
                        logError_1 = _a.sent();
                        // Don't throw if logging fails - we don't want to break the actual query
                        console.error('Failed to log query:', logError_1);
                        return [3 /*break*/, 3];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    DatabaseService.prototype.testConnection = function (config) {
        return __awaiter(this, void 0, void 0, function () {
            var connectionOptions, connection, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 4, , 5]);
                        connectionOptions = {
                            host: config.host,
                            port: config.port,
                            user: config.username,
                            password: config.password,
                        };
                        // Only add database if specified
                        if (config.database) {
                            connectionOptions.database = config.database;
                        }
                        return [4 /*yield*/, mysql.createConnection(connectionOptions)];
                    case 1:
                        connection = _a.sent();
                        return [4 /*yield*/, connection.ping()];
                    case 2:
                        _a.sent();
                        return [4 /*yield*/, connection.end()];
                    case 3:
                        _a.sent();
                        return [2 /*return*/, { success: true }];
                    case 4:
                        error_1 = _a.sent();
                        return [2 /*return*/, {
                                success: false,
                                error: error_1 instanceof Error ? error_1.message : 'Unknown error',
                            }];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    DatabaseService.prototype.saveConfig = function (config) {
        return __awaiter(this, void 0, void 0, function () {
            var configs, existingIndex, connection;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.getConfigs()];
                    case 1:
                        configs = _a.sent();
                        existingIndex = configs.findIndex(function (c) { return c.id === config.id; });
                        if (!(existingIndex >= 0)) return [3 /*break*/, 4];
                        configs[existingIndex] = config;
                        connection = this.connections.get(config.id);
                        if (!connection) return [3 /*break*/, 3];
                        return [4 /*yield*/, connection.end()];
                    case 2:
                        _a.sent();
                        this.connections.delete(config.id);
                        _a.label = 3;
                    case 3: return [3 /*break*/, 5];
                    case 4:
                        configs.push(config);
                        _a.label = 5;
                    case 5: return [4 /*yield*/, fs.writeFile(this.configPath, JSON.stringify(configs, null, 2))];
                    case 6:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    DatabaseService.prototype.getConfigs = function () {
        return __awaiter(this, void 0, void 0, function () {
            var data, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, fs.readFile(this.configPath, 'utf-8')];
                    case 1:
                        data = _a.sent();
                        return [2 /*return*/, JSON.parse(data)];
                    case 2:
                        error_2 = _a.sent();
                        return [2 /*return*/, []];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    DatabaseService.prototype.deleteConfig = function (id) {
        return __awaiter(this, void 0, void 0, function () {
            var configs, filtered, connection;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.getConfigs()];
                    case 1:
                        configs = _a.sent();
                        filtered = configs.filter(function (c) { return c.id !== id; });
                        return [4 /*yield*/, fs.writeFile(this.configPath, JSON.stringify(filtered, null, 2))];
                    case 2:
                        _a.sent();
                        connection = this.connections.get(id);
                        if (!connection) return [3 /*break*/, 4];
                        return [4 /*yield*/, connection.end()];
                    case 3:
                        _a.sent();
                        this.connections.delete(id);
                        _a.label = 4;
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    DatabaseService.prototype.getConnection = function (configId, databaseName) {
        return __awaiter(this, void 0, void 0, function () {
            var connectionKey, configs, config, connection, error_3;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        // Use provided database name, or throw error if none provided
                        if (!databaseName) {
                            throw new Error('Database name must be provided');
                        }
                        connectionKey = "".concat(configId, ":").concat(databaseName);
                        // Return existing connection if available
                        if (this.connections.has(connectionKey)) {
                            return [2 /*return*/, this.connections.get(connectionKey)];
                        }
                        return [4 /*yield*/, this.getConfigs()];
                    case 1:
                        configs = _a.sent();
                        config = configs.find(function (c) { return c.id === configId; });
                        if (!config) {
                            throw new Error("Database config not found: ".concat(configId));
                        }
                        return [4 /*yield*/, mysql.createConnection({
                                host: config.host,
                                port: config.port,
                                user: config.username,
                                password: config.password,
                                database: databaseName,
                            })];
                    case 2:
                        connection = _a.sent();
                        _a.label = 3;
                    case 3:
                        _a.trys.push([3, 6, , 8]);
                        return [4 /*yield*/, connection.query('SET SESSION TRANSACTION READ ONLY')];
                    case 4:
                        _a.sent();
                        // Start a read-only transaction
                        return [4 /*yield*/, connection.query('START TRANSACTION READ ONLY')];
                    case 5:
                        // Start a read-only transaction
                        _a.sent();
                        return [3 /*break*/, 8];
                    case 6:
                        error_3 = _a.sent();
                        // If we can't set read-only mode, close connection and fail
                        return [4 /*yield*/, connection.end()];
                    case 7:
                        // If we can't set read-only mode, close connection and fail
                        _a.sent();
                        throw new Error('SECURITY: Failed to enforce read-only mode on database connection');
                    case 8:
                        this.connections.set(connectionKey, connection);
                        return [2 /*return*/, connection];
                }
            });
        });
    };
    DatabaseService.prototype.executeQuery = function (configId, query, databaseName) {
        return __awaiter(this, void 0, void 0, function () {
            var normalizedQuery, error, forbiddenKeywords, _i, forbiddenKeywords_1, keyword, error, error, connection, _a, rows, fields, result, error_4, errorMessage;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 12, , 15]);
                        normalizedQuery = query.trim().toUpperCase();
                        if (!(!normalizedQuery.startsWith('SELECT') &&
                            !normalizedQuery.startsWith('SHOW') &&
                            !normalizedQuery.startsWith('DESCRIBE') &&
                            !normalizedQuery.startsWith('EXPLAIN'))) return [3 /*break*/, 2];
                        error = 'SECURITY VIOLATION: Only SELECT, SHOW, DESCRIBE, and EXPLAIN queries are allowed. Write operations are NEVER permitted.';
                        return [4 /*yield*/, this.logQuery(query, databaseName, configId, false, error)];
                    case 1:
                        _b.sent();
                        throw new Error(error);
                    case 2:
                        forbiddenKeywords = [
                            'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'REPLACE',
                            'RENAME', 'GRANT', 'REVOKE', 'LOCK', 'UNLOCK', 'CALL', 'EXECUTE', 'LOAD',
                            'INTO OUTFILE', 'INTO DUMPFILE', 'LOAD DATA', 'LOAD XML',
                        ];
                        _i = 0, forbiddenKeywords_1 = forbiddenKeywords;
                        _b.label = 3;
                    case 3:
                        if (!(_i < forbiddenKeywords_1.length)) return [3 /*break*/, 6];
                        keyword = forbiddenKeywords_1[_i];
                        if (!normalizedQuery.includes(keyword)) return [3 /*break*/, 5];
                        error = "SECURITY VIOLATION: Query contains forbidden keyword: ".concat(keyword, ". Write operations are NEVER permitted.");
                        return [4 /*yield*/, this.logQuery(query, databaseName, configId, false, error)];
                    case 4:
                        _b.sent();
                        throw new Error(error);
                    case 5:
                        _i++;
                        return [3 /*break*/, 3];
                    case 6:
                        if (!(query.includes(';') && !query.trim().endsWith(';'))) return [3 /*break*/, 8];
                        error = 'SECURITY VIOLATION: Multiple statements detected. Only single read queries are allowed.';
                        return [4 /*yield*/, this.logQuery(query, databaseName, configId, false, error)];
                    case 7:
                        _b.sent();
                        throw new Error(error);
                    case 8: return [4 /*yield*/, this.getConnection(configId, databaseName)];
                    case 9:
                        connection = _b.sent();
                        return [4 /*yield*/, connection.query(query)];
                    case 10:
                        _a = _b.sent(), rows = _a[0], fields = _a[1];
                        result = {
                            columns: (fields === null || fields === void 0 ? void 0 : fields.map(function (f) { return f.name; })) || [],
                            rows: rows,
                            rowCount: Array.isArray(rows) ? rows.length : 0,
                        };
                        // Log successful query
                        return [4 /*yield*/, this.logQuery(query, databaseName, configId, true, undefined, result.rowCount)];
                    case 11:
                        // Log successful query
                        _b.sent();
                        return [2 /*return*/, result];
                    case 12:
                        error_4 = _b.sent();
                        errorMessage = error_4 instanceof Error ? error_4.message : 'Unknown error';
                        if (!!errorMessage.includes('SECURITY VIOLATION')) return [3 /*break*/, 14];
                        return [4 /*yield*/, this.logQuery(query, databaseName, configId, false, errorMessage)];
                    case 13:
                        _b.sent();
                        _b.label = 14;
                    case 14: throw error_4;
                    case 15: return [2 /*return*/];
                }
            });
        });
    };
    DatabaseService.prototype.getTableSchema = function (configId, tableName, databaseName) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.executeQuery(configId, "DESCRIBE ".concat(tableName), databaseName)];
                    case 1: return [2 /*return*/, _a.sent()];
                }
            });
        });
    };
    DatabaseService.prototype.listTables = function (configId, databaseName) {
        return __awaiter(this, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.executeQuery(configId, 'SHOW TABLES', databaseName)];
                    case 1:
                        result = _a.sent();
                        return [2 /*return*/, result.rows.map(function (row) { return Object.values(row)[0]; })];
                }
            });
        });
    };
    return DatabaseService;
}());
exports.DatabaseService = DatabaseService;
