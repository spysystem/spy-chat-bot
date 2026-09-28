import * as fs from 'fs/promises';
import * as path from 'path';
import {LATENCY_FLAGS} from './latency-flags';

export interface VectorDocument {
	id: string;
	text: string;
	metadata?: Record<string, unknown>;
}

export interface VectorStore {
	version: string;
	documents: VectorDocument[];
}

export class VectorStoreService {
	private readonly vectorStorePath: string;
	private store: VectorStore | null                                                                     = null;
	private readonly searchCache                                                                          = new Map<string, {
		results: VectorDocument[];
		createdAtMs: number
	}>();
	private readonly searchCacheTtlMs                                                                     = 5 * 60 * 1000;
	private lastSearchMeta: { cacheHit: boolean; query: string; topK: number; durationMs: number } | null = null;

	constructor() {
		// Path to vector store in assets directory (pre-built)
		this.vectorStorePath = path.join(__dirname, '../../assets/vector/vector.store');
	}

	/**
	 * Initialize the vector store - load from file.
	 * Supports two formats:
	 *   1. Single JSON object: { version, documents: [...] }
	 *   2. JSONL (one JSON object per line): { id, content, embedding, ... }
	 */
	async initialize(): Promise<void> {
		try {
			const data = await fs.readFile(this.vectorStorePath, 'utf-8');

			// Try standard JSON first (legacy format)
			try {
				const parsed = JSON.parse(data);
				if (parsed && Array.isArray(parsed.documents)) {
					this.store = parsed;
					return;
				}
			} catch {
				// Not valid single-JSON – fall through to JSONL parsing
			}

			// Parse as JSONL (one JSON object per line)
			const documents: VectorDocument[] = [];
			for (const line of data.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				try {
					const entry = JSON.parse(trimmed);
					documents.push({
						id      : entry.id || `doc-${documents.length}`,
						text    : entry.content || entry.text || '',
						metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : undefined,
					});
				} catch {
					// Skip malformed lines
					console.warn('Skipping malformed JSONL line in vector store');
				}
			}

			if (documents.length === 0) {
				throw new Error('Vector store file contains no valid documents');
			}

			this.store = {version: '1.0', documents};
			console.log(`[VectorStoreService] Loaded ${documents.length} documents from JSONL vector store`);
		} catch (error) {
			console.error('Error loading vector store from assets:', error);
			throw new Error('Vector store file not found or invalid: assets/vector/vector.store');
		}
	}


	/**
	 * Search for relevant documents using a two-stage approach:
	 *   1. Fast local keyword pre-filter to find the best ~30 candidates
	 *   2. Local weighted reranking (provider-agnostic, no model/API calls)
	 */
	async search(query: string, topK: number = 3): Promise<VectorDocument[]> {
		const startMs = Date.now();
		if (!this.store || this.store.documents.length === 0) {
			this.lastSearchMeta = {cacheHit: false, query, topK, durationMs: Date.now() - startMs};
			return [];
		}
		const cacheKey = `${query.trim().toLowerCase()}::${topK}`;
		if (LATENCY_FLAGS.enableRetrievalCaches) {
			const cached = this.searchCache.get(cacheKey);
			if (cached && Date.now() - cached.createdAtMs < this.searchCacheTtlMs) {
				this.lastSearchMeta = {cacheHit: true, query, topK, durationMs: Date.now() - startMs};
				return cached.results;
			}
		}

		// Stage 1: Local keyword pre-filter
		const maxCandidates = 30;
		const candidates    = this.keywordPreFilter(query, maxCandidates);

		if (candidates.length === 0) {
			const fallback = this.store.documents.slice(0, topK);
			if (LATENCY_FLAGS.enableRetrievalCaches) {
				this.searchCache.set(cacheKey, {results: fallback, createdAtMs: Date.now()});
			}
			this.lastSearchMeta = {cacheHit: false, query, topK, durationMs: Date.now() - startMs};
			return fallback;
		}

		// If we have very few candidates, return directly
		if (candidates.length <= topK) {
			if (LATENCY_FLAGS.enableRetrievalCaches) {
				this.searchCache.set(cacheKey, {results: candidates, createdAtMs: Date.now()});
			}
			this.lastSearchMeta = {cacheHit: false, query, topK, durationMs: Date.now() - startMs};
			return candidates;
		}

		// Stage 2: Local weighted reranking for better precision on the candidate set.
		const reranked = this.localRerank(query, candidates, topK);
		if (LATENCY_FLAGS.enableRetrievalCaches) {
			this.searchCache.set(cacheKey, {results: reranked, createdAtMs: Date.now()});
		}
		this.cleanupExpiredCache();
		this.lastSearchMeta = {cacheHit: false, query, topK, durationMs: Date.now() - startMs};
		return reranked;
	}

	getLastSearchMeta(): { cacheHit: boolean; query: string; topK: number; durationMs: number } | null {
		return this.lastSearchMeta;
	}

	private cleanupExpiredCache(): void {
		const now = Date.now();
		for (const [key, value] of this.searchCache.entries()) {
			if (now - value.createdAtMs >= this.searchCacheTtlMs) {
				this.searchCache.delete(key);
			}
		}
	}

	/**
	 * Fast keyword-based pre-filter. Scores each document by how many query
	 * tokens appear in its text (case-insensitive). Returns the top N matches
	 * sorted by relevance score descending.
	 */
	private keywordPreFilter(query: string, maxResults: number): VectorDocument[] {
		if (!this.store) {
			return [];
		}

		// Tokenize query: extract meaningful words (4+ chars) and keep short important ones
		const stopWords = new Set([
			'hvor', 'hvad', 'hvem', 'hvordan', 'hvorfor', 'hvornår', 'kan', 'skal', 'vil',
			'jeg', 'min', 'mit', 'mine', 'det', 'den', 'der', 'som', 'til', 'med',
			'fra', 'for', 'ikke', 'har', 'alle', 'this', 'that', 'the', 'and', 'for',
			'with', 'from', 'have', 'show', 'what', 'how', 'where', 'when', 'does',
		]);

		const tokens = (query.toLowerCase().match(/[a-zæøå0-9_]+/gi) || [])
			.map((t) => t.toLowerCase())
			.filter((t) => t.length >= 2 && !stopWords.has(t));

		if (tokens.length === 0) {
			// No meaningful tokens – return first N documents as fallback
			return this.store.documents.slice(0, maxResults);
		}

		// Score each document
		const scored: Array<{ doc: VectorDocument; score: number }> = [];
		for (const doc of this.store.documents) {
			const textLower = doc.text.toLowerCase();
			let score       = 0;

			for (const token of tokens) {
				// Count occurrences of this token in the document
				let pos = 0;
				while ((pos = textLower.indexOf(token, pos)) !== -1) {
					score++;
					pos += token.length;
				}
			}

			// Bonus: exact multi-word phrase match
			const phraseTokens = tokens.filter((t) => t.length >= 3);
			if (phraseTokens.length >= 2) {
				const phrase = phraseTokens.join(' ');
				if (textLower.includes(phrase)) {
					score += 5;
				}
				// Also try without spaces (e.g., "b2c" as part of compound terms)
				const joined = phraseTokens.join('');
				if (textLower.includes(joined)) {
					score += 3;
				}
			}

			if (score > 0) {
				scored.push({doc, score});
			}
		}

		// Sort by score descending and return top N
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, maxResults).map((s) => s.doc);
	}

	/**
	 * Provider-agnostic local reranking using weighted token and phrase matching.
	 */
	private localRerank(query: string, candidates: VectorDocument[], topK: number): VectorDocument[] {
		const stopWords = new Set([
			'hvor', 'hvad', 'hvem', 'hvordan', 'hvorfor', 'hvornår', 'kan', 'skal', 'vil',
			'jeg', 'min', 'mit', 'mine', 'det', 'den', 'der', 'som', 'til', 'med',
			'fra', 'for', 'ikke', 'har', 'alle', 'this', 'that', 'the', 'and',
			'with', 'from', 'have', 'show', 'what', 'how', 'where', 'when', 'does',
		]);
		const tokens    = (query.toLowerCase().match(/[a-zæøå0-9_]+/gi) || [])
			.map((t) => t.toLowerCase())
			.filter((t) => t.length >= 2 && !stopWords.has(t));

		if (tokens.length === 0) {
			return candidates.slice(0, topK);
		}

		const phrase = tokens.length >= 2 ? tokens.join(' ') : '';
		const ranked = candidates
			.map((doc) => {
				const textLower = doc.text.toLowerCase();
				let score       = 0;

				for (const token of tokens) {
					const regex   = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
					const matches = textLower.match(regex);
					score += (matches?.length ?? 0) * 3;
					if (!matches && textLower.includes(token)) {
						score += 1;
					}
				}

				if (phrase && textLower.includes(phrase)) {
					score += 8;
				}

				return {doc, score};
			})
			.sort((a, b) => b.score - a.score);

		return ranked.slice(0, topK).map((item) => item.doc);
	}
}
