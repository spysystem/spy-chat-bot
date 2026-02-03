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
exports.ChatService = void 0;
var fs = require("fs/promises");
var path = require("path");
var crypto_1 = require("crypto");
var electron_1 = require("electron");
var ChatService = /** @class */ (function () {
    function ChatService() {
        this.chatsPath = path.join(electron_1.app.getPath('userData'), 'chats.json');
    }
    ChatService.prototype.getChats = function () {
        return __awaiter(this, void 0, void 0, function () {
            var data, chats, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, fs.readFile(this.chatsPath, 'utf-8')];
                    case 1:
                        data = _a.sent();
                        chats = JSON.parse(data);
                        // Sort by most recently updated
                        return [2 /*return*/, chats.sort(function (a, b) {
                                return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
                            })];
                    case 2:
                        error_1 = _a.sent();
                        return [2 /*return*/, []];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    ChatService.prototype.getChat = function (chatId) {
        return __awaiter(this, void 0, void 0, function () {
            var chats;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.getChats()];
                    case 1:
                        chats = _a.sent();
                        return [2 /*return*/, chats.find(function (c) { return c.id === chatId; }) || null];
                }
            });
        });
    };
    ChatService.prototype.createChat = function () {
        return __awaiter(this, arguments, void 0, function (title) {
            var chat, chats;
            if (title === void 0) { title = 'New Chat'; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        chat = {
                            id: (0, crypto_1.randomUUID)(),
                            title: title,
                            messages: [],
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                        };
                        return [4 /*yield*/, this.getChats()];
                    case 1:
                        chats = _a.sent();
                        chats.push(chat);
                        return [4 /*yield*/, this.saveChats(chats)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/, chat];
                }
            });
        });
    };
    ChatService.prototype.updateChat = function (chatId, messages, title, databaseName, branch) {
        return __awaiter(this, void 0, void 0, function () {
            var chats, chatIndex, firstUserMessage;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.getChats()];
                    case 1:
                        chats = _a.sent();
                        chatIndex = chats.findIndex(function (c) { return c.id === chatId; });
                        if (chatIndex === -1) {
                            throw new Error("Chat not found: ".concat(chatId));
                        }
                        chats[chatIndex].messages = messages;
                        chats[chatIndex].updatedAt = new Date().toISOString();
                        // Update database name if provided
                        if (databaseName !== undefined) {
                            chats[chatIndex].databaseName = databaseName;
                        }
                        // Update branch if provided
                        if (branch !== undefined) {
                            chats[chatIndex].branch = branch;
                        }
                        // Auto-generate title from first user message if not set
                        if (title) {
                            chats[chatIndex].title = title;
                        }
                        else if (chats[chatIndex].title === 'New Chat' && messages.length > 0) {
                            firstUserMessage = messages.find(function (m) { return m.role === 'user'; });
                            if (firstUserMessage) {
                                chats[chatIndex].title = firstUserMessage.content.substring(0, 50) +
                                    (firstUserMessage.content.length > 50 ? '...' : '');
                            }
                        }
                        return [4 /*yield*/, this.saveChats(chats)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    ChatService.prototype.deleteChat = function (chatId) {
        return __awaiter(this, void 0, void 0, function () {
            var chats, filtered;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.getChats()];
                    case 1:
                        chats = _a.sent();
                        filtered = chats.filter(function (c) { return c.id !== chatId; });
                        return [4 /*yield*/, this.saveChats(filtered)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    ChatService.prototype.saveChats = function (chats) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, fs.writeFile(this.chatsPath, JSON.stringify(chats, null, 2), 'utf-8')];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    return ChatService;
}());
exports.ChatService = ChatService;
