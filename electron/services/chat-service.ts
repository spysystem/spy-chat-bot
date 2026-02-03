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
	databaseName?: string;
	branch?: string;
	workingSummary?: {
		text: string;
		updatedAt: string;
	};
	createdAt: string;
	updatedAt: string;
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
			id       : randomUUID(),
			title,
			messages : [],
			workingSummary: {
				text: '',
				updatedAt: new Date().toISOString(),
			},
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		const chats = await this.getChats();
		chats.push(chat);
		await this.saveChats(chats);

		return chat;
	}

	async updateChat(chatId: string, messages: ChatMessage[], title?: string, databaseName?: string, branch?: string): Promise<void> {
		const chats     = await this.getChats();
		const chatIndex = chats.findIndex((c) => c.id === chatId);

		if (chatIndex === -1) {
			throw new Error(`Chat not found: ${chatId}`);
		}

		chats[chatIndex].messages  = messages;
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
		} else if (chats[chatIndex].title === 'New Chat' && messages.length > 0) {
			const firstUserMessage = messages.find((m) => m.role === 'user');
			if (firstUserMessage) {
				chats[chatIndex].title = firstUserMessage.content.substring(0, 50) +
					(firstUserMessage.content.length > 50 ? '...' : '');
			}
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
		chats[chatIndex].updatedAt = new Date().toISOString();

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
