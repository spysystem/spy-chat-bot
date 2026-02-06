import * as fs from 'fs/promises';
import * as path from 'path';
import {randomUUID} from 'crypto';
import {app} from 'electron';

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	detailedContent?: string;
	timestamp: string;
	attachments?: Array<{
		id: string;
		originalName: string;
		mimeType: string;
		sizeBytes: number;
		storedPath: string;
	}>;
}

export interface Chat {
	id: string;

	title: string;
	messages: ChatMessage[];

	// Per-chat system context (selected from System Directory API or dev-mode input)
	systemKey?: string;
	systemName?: string;
	dbHost?: string;
	release?: string;
	isRestore?: boolean;
	isDevMode?: boolean;

	databaseName?: string;
	branch?: string;
	systemUrl?: string;
	workingSummary?: {
		text: string;
		updatedAt: string;
	};
	createdAt: string;
	updatedAt: string;
}

export interface ChatUpdate {
	title?: string;
	databaseName?: string;
	branch?: string;
	systemKey?: string;
	systemName?: string;
	dbHost?: string;
	release?: string;
	isRestore?: boolean;
	isDevMode?: boolean;
	systemUrl?: string;
}

function normalizeTitleSeed(value: string): string {
	return value
		.replace(/\s+/g, ' ')
		.replace(/[^\p{L}\p{N}\s_-]+/gu, '')
		.trim();
}

function generateChatTitle(messages: ChatMessage[], context?: { systemName?: string; databaseName?: string }): string {
	// Title generation is deterministic and does not call external services.
	// Keep it stable by using up to the first 3 user messages.
	const userTexts = messages
		.filter((m) => m.role === 'user')
		.map((m) => normalizeTitleSeed(m.content))
		.filter((t) => t.length >= 4)
		.slice(0, 3);

	const contextPrefixRaw = normalizeTitleSeed(context?.systemName || '') || normalizeTitleSeed(context?.databaseName || '');
	const contextPrefix    = contextPrefixRaw ? `${contextPrefixRaw} - ` : '';

	if (userTexts.length === 0) {
		return contextPrefixRaw || 'New Chat';
	}

	const joined = userTexts.join(' ');
	const stop   = new Set([
		// Danish
		'og', 'eller', 'men', 'det', 'den', 'der', 'som', 'til', 'på', 'i', 'af', 'for', 'med', 'fra', 'kan', 'skal', 'vil',
		'hvad', 'hvor', 'hvordan', 'hvem', 'hvorfor', 'lige', 'meget', 'bare', 'når', 'ikke', 'ingen', 'min', 'mit', 'mine',
		// English
		'the', 'a', 'an', 'and', 'or', 'but', 'to', 'in', 'on', 'of', 'for', 'with', 'from', 'can', 'should', 'will', 'what', 'where', 'how', 'why',
	]);

	const tokens = (joined.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [])
		.filter((t) => !stop.has(t));

	const counts = new Map<string, number>();
	for (const t of tokens) {
		counts.set(t, (counts.get(t) ?? 0) + 1);
	}

	const top = Array.from(counts.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 4)
		.map(([t]) => t);

	const keywordTitle = top.length > 0 ? top.join(' ') : userTexts[0];
	const full         = `${contextPrefix}${keywordTitle}`.trim();

	// Clamp length for UI.
	const maxLen = 60;
	return full.length > maxLen ? `${full.substring(0, maxLen - 3)}...` : full;
}

export class ChatService {
	private readonly chatsPath: string;

	constructor() {
		this.chatsPath = path.join(app.getPath('userData'), 'chats.json');
	}

	async getChats(): Promise<Chat[]> {
		try {
			const data  = await fs.readFile(this.chatsPath, 'utf-8');
			const chats = JSON.parse(data);
			// Sort by most recently updated
			return chats.sort((a: Chat, b: Chat) =>
				new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
			);
		} catch (error) {
			return [];
		}
	}

	async getChat(chatId: string): Promise<Chat | null> {
		const chats = await this.getChats();
		return chats.find((c) => c.id === chatId) || null;
	}

	async createChat(title: string = 'New Chat'): Promise<Chat> {
		const chat: Chat = {
			id            : randomUUID(),
			title,
			messages      : [],
			workingSummary: {
				text     : '',
				updatedAt: new Date().toISOString(),
			},
			createdAt     : new Date().toISOString(),
			updatedAt     : new Date().toISOString(),
		};

		const chats = await this.getChats();
		chats.push(chat);
		await this.saveChats(chats);

		return chat;
	}

	async updateChat(chatId: string, messages: ChatMessage[], update?: ChatUpdate): Promise<void> {
		const chats     = await this.getChats();
		const chatIndex = chats.findIndex((c) => c.id === chatId);

		if (chatIndex === -1) {
			throw new Error(`Chat not found: ${chatId}`);
		}

		chats[chatIndex].messages  = messages;
		chats[chatIndex].updatedAt = new Date().toISOString();

		if (update) {
			if (update.databaseName !== undefined) {
				chats[chatIndex].databaseName = update.databaseName;
			}
			if (update.branch !== undefined) {
				chats[chatIndex].branch = update.branch;
			}
			if (update.systemKey !== undefined) {
				chats[chatIndex].systemKey = update.systemKey;
			}
			if (update.systemName !== undefined) {
				chats[chatIndex].systemName = update.systemName;
			}
			if (update.dbHost !== undefined) {
				chats[chatIndex].dbHost = update.dbHost;
			}
			if (update.release !== undefined) {
				chats[chatIndex].release = update.release;
			}
			if (update.isRestore !== undefined) {
				chats[chatIndex].isRestore = update.isRestore;
			}
			if (update.isDevMode !== undefined) {
				chats[chatIndex].isDevMode = update.isDevMode;
			}
			if (update.systemUrl !== undefined) {
				chats[chatIndex].systemUrl = update.systemUrl;
			}
		}

		// Auto-generate title from first user message if not set
		if (update?.title) {
			chats[chatIndex].title = update.title;
		} else {
			chats[chatIndex].title = generateChatTitle(messages, {
				systemName  : chats[chatIndex].systemName,
				databaseName: chats[chatIndex].databaseName,
			});
		}

		await this.saveChats(chats);
	}

	async setWorkingSummary(chatId: string, text: string): Promise<void> {
		const chats     = await this.getChats();
		const chatIndex = chats.findIndex((c) => c.id === chatId);
		if (chatIndex === -1) {
			throw new Error(`Chat not found: ${chatId}`);
		}

		chats[chatIndex].workingSummary = {
			text,
			updatedAt: new Date().toISOString(),
		};
		chats[chatIndex].updatedAt      = new Date().toISOString();

		await this.saveChats(chats);
	}

	async clearWorkingSummary(chatId: string): Promise<void> {
		return await this.setWorkingSummary(chatId, '');
	}

	async deleteChat(chatId: string): Promise<void> {
		const chats    = await this.getChats();
		const filtered = chats.filter((c) => c.id !== chatId);
		await this.saveChats(filtered);
	}

	private async saveChats(chats: Chat[]): Promise<void> {
		await fs.writeFile(this.chatsPath, JSON.stringify(chats, null, 2), 'utf-8');
	}
}
