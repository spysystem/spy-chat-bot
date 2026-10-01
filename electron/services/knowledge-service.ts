import * as fs from 'fs/promises';
import * as path from 'path';

export interface KnowledgeDocument {
	id: string;
	text: string;
}

const STOPWORDS = new Set([
	// Danish
	'og', 'i', 'jeg', 'det', 'at', 'en', 'den', 'til', 'er', 'som', 'på', 'de', 'med', 'han', 'af', 'for', 'ikke', 'der',
	'var', 'mig', 'sig', 'men', 'et', 'har', 'om', 'vi', 'min', 'havde', 'ham', 'hun', 'nu', 'over', 'da', 'fra', 'du',
	'ud', 'sin', 'dem', 'os', 'op', 'man', 'hans', 'hvor', 'eller', 'hvad', 'skal', 'selv', 'her', 'alle', 'vil', 'blev',
	'kunne', 'ind', 'når', 'være', 'dog', 'noget', 'ville', 'jo', 'deres', 'efter', 'ned', 'skulle', 'denne', 'end',
	'dette', 'mit', 'også', 'under', 'have', 'dig', 'anden', 'hende', 'mine', 'alt', 'meget', 'sit', 'sine', 'vor',
	'mod', 'disse', 'hvis', 'din', 'nogle', 'hos', 'blive', 'mange', 'ad', 'bliver', 'hendes', 'været', 'thi', 'jer',
	'sådan', 'hvordan', 'hvorfor', 'hvem', 'kan',
	// English
	'the', 'a', 'an', 'and', 'or', 'to', 'in', 'on', 'of', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'do',
	'does', 'did', 'how', 'what', 'why', 'who', 'where', 'when', 'which', 'this', 'that', 'it', 'as', 'at', 'by', 'from',
	'can', 'i', 'we', 'you', 'my', 'our', 'not', 'no', 'if', 'so', 'into',
	// SQL noise that appears in almost every schema chunk
	'select', 'from', 'inner', 'join', 'where', 'id', 'default', 'null', 'not',
]);

function tokenize(text: string): string[] {
	const tokens: string[] = [];
	for (const raw of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
		if (raw.length >= 2 && !STOPWORDS.has(raw)) {
			tokens.push(raw);
		}
		// snake_case identifiers are also indexed by their parts ("s_order_main" -> "order", "main").
		if (raw.includes('_')) {
			for (const part of raw.split('_')) {
				if (part.length >= 3 && !STOPWORDS.has(part)) {
					tokens.push(part);
				}
			}
		}
	}
	return tokens;
}

/**
 * Keyword retrieval (BM25) over the bundled example SQL queries (one JSONL line per example).
 */
export class KnowledgeService {
	private readonly storePath: string;
	private documents: KnowledgeDocument[]              = [];
	private termFrequencies: Array<Map<string, number>> = [];
	private documentLengths: number[]                   = [];
	private documentFrequency                           = new Map<string, number>();
	private averageLength                               = 0;
	private loading: Promise<void> | null               = null;

	constructor(storePath: string = path.join(__dirname, '../../assets/knowledge/sql-examples.jsonl')) {
		this.storePath = storePath;
	}

	async ensureLoaded(): Promise<void> {
		if (!this.loading) {
			this.loading = this.load().catch((error) => {
				this.loading = null;
				throw error;
			});
		}
		await this.loading;
	}

	private async load(): Promise<void> {
		const raw                       = await fs.readFile(this.storePath, 'utf-8');
		const docs: KnowledgeDocument[] = [];
		for (const line of raw.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			try {
				const entry = JSON.parse(trimmed);
				const text  = String(entry.content ?? entry.text ?? '').trim();
				if (text) {
					docs.push({id: String(entry.id ?? `doc-${docs.length}`), text});
				}
			} catch {
				// Skip malformed lines.
			}
		}

		this.documents       = docs;
		this.termFrequencies = [];
		this.documentLengths = [];
		this.documentFrequency.clear();
		let totalLength = 0;
		for (const doc of docs) {
			const tokens = tokenize(doc.text);
			const tf     = new Map<string, number>();
			for (const token of tokens) {
				tf.set(token, (tf.get(token) ?? 0) + 1);
			}
			for (const token of tf.keys()) {
				this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
			}
			this.termFrequencies.push(tf);
			this.documentLengths.push(tokens.length);
			totalLength += tokens.length;
		}
		this.averageLength = docs.length > 0 ? totalLength / docs.length : 0;
	}

	async search(query: string, limit: number = 5): Promise<KnowledgeDocument[]> {
		await this.ensureLoaded();
		const terms = Array.from(new Set(tokenize(query)));
		if (terms.length === 0 || this.documents.length === 0) {
			return [];
		}

		const k1                                              = 1.2;
		const b                                               = 0.75;
		const n                                               = this.documents.length;
		const scored: Array<{ index: number; score: number }> = [];
		for (let i = 0; i < n; i++) {
			const tf  = this.termFrequencies[i];
			let score = 0;
			for (const term of terms) {
				const freq = tf.get(term);
				if (!freq) {
					continue;
				}
				const df  = this.documentFrequency.get(term) ?? 0;
				const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
				score += idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (this.documentLengths[i] / this.averageLength)));
			}
			if (score > 0) {
				scored.push({index: i, score});
			}
		}

		scored.sort((a, b2) => b2.score - a.score);
		return scored.slice(0, limit).map(({index}) => this.documents[index]);
	}
}
