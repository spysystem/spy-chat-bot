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
	 * Initialize the vector store - load from file
	 */
	async initialize(): Promise<void> {
		try {
			// Load the pre-built vector store from assets
			const data = await fs.readFile(this.vectorStorePath, 'utf-8');
			this.store = JSON.parse(data);
		} catch (error) {
			console.error('Error loading vector store from assets:', error);
			throw new Error('Vector store file not found in assets/vector/vector.store');
		}
	}


	/**
	 * Search for relevant documents using Claude's semantic understanding
	 */
	async search(query: string, topK: number = 3): Promise<VectorDocument[]> {
		if (!this.store || this.store.documents.length === 0) {
			return [];
		}

		// Use Claude to find the most relevant documents
		const client = new Anthropic({apiKey: this.apiKey});

		// Create a prompt that asks Claude to select the most relevant documents
		const documentsText = this.store.documents
			.map((doc, index) => `[${index}] ${doc.text}`)
			.join('\n\n');

		const prompt = `Du er en assistent der hjælper med at finde relevante dokumenter til en forespørgsel.

Brugerens forespørgsel: "${query}"

Tilgængelige dokumenter:
${documentsText}

Vælg de ${topK} mest relevante dokumenter til brugerens forespørgsel. Returner KUN en JSON array med document indices (f.eks. [0, 3, 7]).
Hvis forespørgslen er generel eller ikke specifik, vælg de mest grundlæggende/vigtige dokumenter.`;

		try {
			const response = await client.messages.create({
				model     : 'claude-3-5-haiku-20241022', // Use fast Haiku model for quick retrieval
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
				return this.store.documents.slice(0, topK);
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
				return this.store.documents.slice(0, topK);
			}

			// Parse the JSON array of indices
			const selectedIndices = JSON.parse(arrayMatch[0]);
			// Return the selected documents
			return selectedIndices
				.filter((index: number) => index >= 0 && index < this.store!.documents.length)
				.map((index: number) => this.store!.documents[index])
				.slice(0, topK);
		} catch (error) {
			console.error('Error searching vector store:', error);
			// Fallback: return first topK documents
			return this.store.documents.slice(0, topK);
		}
	}
}
