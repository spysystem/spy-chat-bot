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
exports.VectorStoreService = void 0;
var fs = require("fs/promises");
var path = require("path");
var sdk_1 = require("@anthropic-ai/sdk");
var VectorStoreService = /** @class */ (function () {
    function VectorStoreService(apiKey) {
        this.apiKey = apiKey;
        this.store = null;
        // Path to vector store in assets directory (pre-built)
        this.vectorStorePath = path.join(__dirname, '../../assets/vector/vector.store');
    }
    /**
     * Initialize the vector store - load from file
     */
    VectorStoreService.prototype.initialize = function () {
        return __awaiter(this, void 0, void 0, function () {
            var data, error_1;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, fs.readFile(this.vectorStorePath, 'utf-8')];
                    case 1:
                        data = _b.sent();
                        this.store = JSON.parse(data);
                        console.log("Loaded vector store with ".concat(((_a = this.store) === null || _a === void 0 ? void 0 : _a.documents.length) || 0, " documents from assets"));
                        return [3 /*break*/, 3];
                    case 2:
                        error_1 = _b.sent();
                        console.error('Error loading vector store from assets:', error_1);
                        throw new Error('Vector store file not found in assets/vector/vector.store');
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Search for relevant documents using Claude's semantic understanding
     */
    VectorStoreService.prototype.search = function (query_1) {
        return __awaiter(this, arguments, void 0, function (query, topK) {
            var client, documentsText, prompt, response, textContent, jsonText, match, arrayMatch, selectedIndices, selectedDocs, error_2;
            var _this = this;
            if (topK === void 0) { topK = 3; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.store || this.store.documents.length === 0) {
                            return [2 /*return*/, []];
                        }
                        client = new sdk_1.default({ apiKey: this.apiKey });
                        documentsText = this.store.documents
                            .map(function (doc, index) { return "[".concat(index, "] ").concat(doc.text); })
                            .join('\n\n');
                        prompt = "Du er en assistent der hj\u00E6lper med at finde relevante dokumenter til en foresp\u00F8rgsel.\n\nBrugerens foresp\u00F8rgsel: \"".concat(query, "\"\n\nTilg\u00E6ngelige dokumenter:\n").concat(documentsText, "\n\nV\u00E6lg de ").concat(topK, " mest relevante dokumenter til brugerens foresp\u00F8rgsel. Returner KUN en JSON array med document indices (f.eks. [0, 3, 7]).\nHvis foresp\u00F8rgslen er generel eller ikke specifik, v\u00E6lg de mest grundl\u00E6ggende/vigtige dokumenter.");
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, client.messages.create({
                                model: 'claude-3-5-haiku-20241022', // Use fast Haiku model for quick retrieval
                                max_tokens: 256,
                                messages: [
                                    {
                                        role: 'user',
                                        content: prompt,
                                    },
                                ],
                            })];
                    case 2:
                        response = _a.sent();
                        textContent = response.content.find(function (c) { return c.type === 'text'; });
                        if (!textContent || textContent.type !== 'text') {
                            return [2 /*return*/, this.store.documents.slice(0, topK)];
                        }
                        jsonText = textContent.text.trim();
                        // Remove markdown code blocks if present
                        if (jsonText.includes('```')) {
                            match = jsonText.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
                            if (match) {
                                jsonText = match[1];
                            }
                        }
                        arrayMatch = jsonText.match(/\[[\s\S]*?\]/);
                        if (!arrayMatch) {
                            console.warn('No JSON array found in Claude response, using fallback');
                            return [2 /*return*/, this.store.documents.slice(0, topK)];
                        }
                        selectedIndices = JSON.parse(arrayMatch[0]);
                        console.log("[Vector Store] Claude Haiku selected indices: [".concat(selectedIndices.join(', '), "] for query: \"").concat(query.substring(0, 60)).concat(query.length > 60 ? '...' : '', "\""));
                        selectedDocs = selectedIndices
                            .filter(function (index) { return index >= 0 && index < _this.store.documents.length; })
                            .map(function (index) { return _this.store.documents[index]; })
                            .slice(0, topK);
                        // Log selected document IDs
                        console.log("[Vector Store] Returning ".concat(selectedDocs.length, " documents:"), selectedDocs.map(function (d) { return d.id; }));
                        return [2 /*return*/, selectedDocs];
                    case 3:
                        error_2 = _a.sent();
                        console.error('Error searching vector store:', error_2);
                        // Fallback: return first topK documents
                        return [2 /*return*/, this.store.documents.slice(0, topK)];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get all documents
     */
    VectorStoreService.prototype.getAllDocuments = function () {
        var _a;
        return ((_a = this.store) === null || _a === void 0 ? void 0 : _a.documents) || [];
    };
    return VectorStoreService;
}());
exports.VectorStoreService = VectorStoreService;
