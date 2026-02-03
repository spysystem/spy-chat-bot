"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
exports.GitHubService = void 0;
var fs = require("fs/promises");
var path = require("path");
var electron_1 = require("electron");
var GitHubService = /** @class */ (function () {
    function GitHubService() {
        this.config = null;
        this.configPath = path.join(electron_1.app.getPath('userData'), 'github-config.json');
    }
    GitHubService.prototype.getConfig = function () {
        return __awaiter(this, void 0, void 0, function () {
            var data, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, fs.readFile(this.configPath, 'utf-8')];
                    case 1:
                        data = _a.sent();
                        this.config = JSON.parse(data);
                        return [2 /*return*/, this.config];
                    case 2:
                        error_1 = _a.sent();
                        return [2 /*return*/, null];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    GitHubService.prototype.saveConfig = function (config) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8')];
                    case 1:
                        _a.sent();
                        this.config = config;
                        return [2 /*return*/];
                }
            });
        });
    };
    GitHubService.prototype.getAuthorizationHeader = function () {
        if (!this.config) {
            throw new Error('GitHub not configured');
        }
        // Trim whitespace from token
        var token = this.config.token.trim();
        // Debug logging
        console.log('[GitHubService] Token prefix:', token.substring(0, 10) + '...');
        console.log('[GitHubService] Token length:', token.length);
        // Fine-grained tokens (github_pat_*) use Bearer, classic tokens (ghp_*) use token
        if (token.startsWith('github_pat_')) {
            console.log('[GitHubService] Using Bearer authentication (fine-grained token)');
            return "Bearer ".concat(token);
        }
        console.log('[GitHubService] Using token authentication (classic token)');
        return "token ".concat(token);
    };
    GitHubService.prototype.validateConfig = function () {
        return __awaiter(this, void 0, void 0, function () {
            var config, authHeader, headers, response, errorText, user, repoResponse, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!!this.config) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.getConfig()];
                    case 1:
                        config = _a.sent();
                        if (!config) {
                            return [2 /*return*/, { valid: false, error: 'GitHub not configured' }];
                        }
                        this.config = config;
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 8, , 9]);
                        authHeader = this.getAuthorizationHeader();
                        console.log('[GitHubService] Full auth header:', authHeader.substring(0, 20) + '...');
                        headers = {
                            'Authorization': authHeader,
                            'Accept': 'application/vnd.github+json',
                            'X-GitHub-Api-Version': '2022-11-28',
                            'User-Agent': 'Sporge-Jorgen-App',
                        };
                        console.log('[GitHubService] Request headers:', JSON.stringify(headers, null, 2).substring(0, 200));
                        return [4 /*yield*/, fetch('https://api.github.com/user', {
                                headers: headers,
                            })];
                    case 3:
                        response = _a.sent();
                        console.log('[GitHubService] Response status:', response.status);
                        if (!!response.ok) return [3 /*break*/, 5];
                        return [4 /*yield*/, response.text()];
                    case 4:
                        errorText = _a.sent();
                        console.log('[GitHubService] Error response:', errorText);
                        return [2 /*return*/, { valid: false, error: "Authentication failed: ".concat(response.status, " - ").concat(errorText) }];
                    case 5: return [4 /*yield*/, response.json()];
                    case 6:
                        user = _a.sent();
                        return [4 /*yield*/, fetch("https://api.github.com/repos/".concat(this.config.owner, "/").concat(this.config.repo), {
                                headers: {
                                    'Authorization': this.getAuthorizationHeader(),
                                    'Accept': 'application/vnd.github+json',
                                    'X-GitHub-Api-Version': '2022-11-28',
                                },
                            })];
                    case 7:
                        repoResponse = _a.sent();
                        if (!repoResponse.ok) {
                            return [2 /*return*/, { valid: false, error: "Cannot access repository ".concat(this.config.owner, "/").concat(this.config.repo) }];
                        }
                        return [2 /*return*/, { valid: true, user: user.login }];
                    case 8:
                        error_2 = _a.sent();
                        return [2 /*return*/, { valid: false, error: String(error_2) }];
                    case 9: return [2 /*return*/];
                }
            });
        });
    };
    GitHubService.prototype.githubRequest = function (endpoint_1) {
        return __awaiter(this, arguments, void 0, function (endpoint, options) {
            var config, url, response, errorText;
            if (options === void 0) { options = {}; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!!this.config) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.getConfig()];
                    case 1:
                        config = _a.sent();
                        if (!config) {
                            throw new Error('GitHub not configured');
                        }
                        this.config = config;
                        _a.label = 2;
                    case 2:
                        url = "https://api.github.com".concat(endpoint);
                        return [4 /*yield*/, fetch(url, __assign(__assign({}, options), { headers: __assign({ 'Authorization': this.getAuthorizationHeader(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, options.headers) }))];
                    case 3:
                        response = _a.sent();
                        if (!!response.ok) return [3 /*break*/, 5];
                        return [4 /*yield*/, response.text()];
                    case 4:
                        errorText = _a.sent();
                        // Special handling for 401 Bad credentials
                        if (response.status === 401) {
                            throw new Error(response.body + "    GitHub API authentication failed (401). Please check:\n1. Token is valid and not expired\n2. Token starts with 'ghp_' or 'github_pat_'\n3. Token has 'repo' scope enabled\n\nGenerate a new token at: https://github.com/settings/tokens");
                        }
                        throw new Error("GitHub API error: ".concat(response.status, " - ").concat(errorText));
                    case 5: return [4 /*yield*/, response.json()];
                    case 6: return [2 /*return*/, _a.sent()];
                }
            });
        });
    };
    GitHubService.prototype.searchCode = function (query) {
        return __awaiter(this, void 0, void 0, function () {
            var config, searchQuery, data, error_3;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!!this.config) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.getConfig()];
                    case 1:
                        config = _a.sent();
                        if (!config) {
                            throw new Error('GitHub not configured');
                        }
                        this.config = config;
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, , 5]);
                        searchQuery = encodeURIComponent("".concat(query, " repo:").concat(this.config.owner, "/").concat(this.config.repo));
                        return [4 /*yield*/, this.githubRequest("/search/code?q=".concat(searchQuery, "&per_page=10"), {
                                headers: {
                                    'Accept': 'application/vnd.github.text-match+json',
                                },
                            })];
                    case 3:
                        data = _a.sent();
                        return [2 /*return*/, data.items.map(function (item) {
                                var _a;
                                return ({
                                    path: item.path,
                                    matches: ((_a = item.text_matches) === null || _a === void 0 ? void 0 : _a.map(function (m) { return m.fragment || ''; })) || [],
                                });
                            })];
                    case 4:
                        error_3 = _a.sent();
                        console.error('[GitHubService] Search error:', error_3);
                        throw error_3;
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    GitHubService.prototype.getFileContent = function (filePath) {
        return __awaiter(this, void 0, void 0, function () {
            var config, encodedPath, data, error_4;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!!this.config) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.getConfig()];
                    case 1:
                        config = _a.sent();
                        if (!config) {
                            throw new Error('GitHub not configured');
                        }
                        this.config = config;
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, , 5]);
                        encodedPath = encodeURIComponent(filePath).replace(/%2F/g, '/');
                        return [4 /*yield*/, this.githubRequest("/repos/".concat(this.config.owner, "/").concat(this.config.repo, "/contents/").concat(encodedPath, "?ref=").concat(this.config.branch))];
                    case 3:
                        data = _a.sent();
                        if (Array.isArray(data) || data.type !== 'file') {
                            throw new Error('Path is not a file');
                        }
                        // Decode base64 content
                        return [2 /*return*/, Buffer.from(data.content, 'base64').toString('utf-8')];
                    case 4:
                        error_4 = _a.sent();
                        console.error('[GitHubService] Get file error:', error_4);
                        throw error_4;
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    GitHubService.prototype.listFiles = function () {
        return __awaiter(this, arguments, void 0, function (directoryPath) {
            var config, encodedPath, data, error_5;
            if (directoryPath === void 0) { directoryPath = ''; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!!this.config) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.getConfig()];
                    case 1:
                        config = _a.sent();
                        if (!config) {
                            throw new Error('GitHub not configured');
                        }
                        this.config = config;
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, , 5]);
                        encodedPath = directoryPath ? encodeURIComponent(directoryPath).replace(/%2F/g, '/') : '';
                        return [4 /*yield*/, this.githubRequest("/repos/".concat(this.config.owner, "/").concat(this.config.repo, "/contents/").concat(encodedPath, "?ref=").concat(this.config.branch))];
                    case 3:
                        data = _a.sent();
                        if (!Array.isArray(data)) {
                            throw new Error('Path is not a directory');
                        }
                        return [2 /*return*/, data.map(function (item) { return ({
                                path: item.path,
                                type: item.type === 'dir' ? 'dir' : 'file',
                            }); })];
                    case 4:
                        error_5 = _a.sent();
                        console.error('[GitHubService] List files error:', error_5);
                        throw error_5;
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    GitHubService.prototype.getTree = function () {
        return __awaiter(this, arguments, void 0, function (recursive) {
            var config, branchData, treeSha, treeData, error_6;
            if (recursive === void 0) { recursive = false; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!!this.config) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.getConfig()];
                    case 1:
                        config = _a.sent();
                        if (!config) {
                            throw new Error('GitHub not configured');
                        }
                        this.config = config;
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 5, , 6]);
                        return [4 /*yield*/, this.githubRequest("/repos/".concat(this.config.owner, "/").concat(this.config.repo, "/branches/").concat(this.config.branch))];
                    case 3:
                        branchData = _a.sent();
                        treeSha = branchData.commit.commit.tree.sha;
                        return [4 /*yield*/, this.githubRequest("/repos/".concat(this.config.owner, "/").concat(this.config.repo, "/git/trees/").concat(treeSha).concat(recursive ? '?recursive=1' : ''))];
                    case 4:
                        treeData = _a.sent();
                        return [2 /*return*/, treeData.tree.map(function (item) { return ({
                                path: item.path || '',
                                type: item.type || '',
                            }); })];
                    case 5:
                        error_6 = _a.sent();
                        console.error('[GitHubService] Get tree error:', error_6);
                        throw error_6;
                    case 6: return [2 /*return*/];
                }
            });
        });
    };
    return GitHubService;
}());
exports.GitHubService = GitHubService;
