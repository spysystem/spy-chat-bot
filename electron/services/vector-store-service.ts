import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs/promises';
import * as path from 'path';

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
	private store: VectorStore | null = null;

	constructor(private apiKey: string) {
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
	 *   2. Claude semantic ranking on the short-list only
	 *
	 * This avoids sending all documents (potentially 1000+) to Claude in one prompt.
	 */
	async search(query: string, topK: number = 3): Promise<VectorDocument[]> {
		if (!this.store || this.store.documents.length === 0) {
			return [];
		}

		// Stage 1: Local keyword pre-filter
		const maxCandidates = 30;
		const candidates    = this.keywordPreFilter(query, maxCandidates);

		if (candidates.length === 0) {
			return this.store.documents.slice(0, topK);
		}

		// If we have very few candidates, skip the Claude call
		if (candidates.length <= topK) {
			return candidates;
		}

		// Stage 2: Use Claude to semantically rank the short-list
		const client = new Anthropic({apiKey: this.apiKey});

		// Build a compact document list for the prompt (truncate long documents)
		const documentsText = candidates
			.map((doc, index) => {
				const preview = doc.text.length > 500 ? doc.text.substring(0, 500) + '...' : doc.text;
				return `[${index}] ${preview}`;
			})
			.join('\n\n');

		const prompt = `Du er en assistent der hjælper med at finde relevante dokumenter til en forespørgsel.

Brugerens forespørgsel: "${query}"

Tilgængelige dokumenter:
${documentsText}

Vælg de ${topK} mest relevante dokumenter til brugerens forespørgsel. Returner KUN en JSON array med document indices (f.eks. [0, 3, 7]).
Hvis forespørgslen er generel eller ikke specifik, vælg de mest grundlæggende/vigtige dokumenter.`;

		try {
			const response = await client.messages.create({
				model     : 'claude-3-5-haiku-20241022',
				max_tokens: 256,
				messages  : [
					{
						role   : 'user',
						content: prompt,
					},
				],
			});

			const textContent = response.content.find((c) => c.type === 'text');
			if (!textContent || textContent.type !== 'text') {
				return candidates.slice(0, topK);
			}

			// Extract JSON from response (handle markdown formatting)
			let jsonText = textContent.text.trim();

			// Remove markdown code blocks if present
			if (jsonText.includes('```')) {
				const match = jsonText.match(/```(?:json)?\s*(\[[\s\S]*?])\s*```/);
				if (match) {
					jsonText = match[1];
				}
			}

			// Find JSON array in the text
			const arrayMatch = jsonText.match(/\[[\s\S]*?]/);
			if (!arrayMatch) {
				console.warn('No JSON array found in Claude response, using fallback');
				return candidates.slice(0, topK);
			}

			// Parse the JSON array of indices (indices are relative to candidates array)
			const selectedIndices = JSON.parse(arrayMatch[0]);
			return selectedIndices
				.filter((index: number) => index >= 0 && index < candidates.length)
				.map((index: number) => candidates[index])
				.slice(0, topK);
		} catch (error) {
			console.error('Error searching vector store:', error);
			// Fallback: return top keyword-matched candidates
			return candidates.slice(0, topK);
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
}
