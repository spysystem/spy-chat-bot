import {app, shell} from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import {randomUUID} from 'crypto';

export interface AttachmentMeta {
	id: string;
	originalName: string;
	mimeType: string;
	sizeBytes: number;
	storedPath: string;
}

function sanitizeFilename(filename: string): string {
	// Keep it readable but safe for filesystem.
	return filename.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120);
}

function guessMimeTypeFromName(name: string): string {
	const lower = name.toLowerCase();
	if (lower.endsWith('.png')) return 'image/png';
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
	if (lower.endsWith('.webp')) return 'image/webp';
	if (lower.endsWith('.gif')) return 'image/gif';
	if (lower.endsWith('.txt')) return 'text/plain';
	if (lower.endsWith('.md')) return 'text/markdown';
	if (lower.endsWith('.json')) return 'application/json';
	if (lower.endsWith('.csv')) return 'text/csv';
	if (lower.endsWith('.log')) return 'text/plain';
	if (lower.endsWith('.pdf')) return 'application/pdf';
	return 'application/octet-stream';
}

export class AttachmentService {
	private readonly baseDir: string;
	private readonly maxBytesPerAttachment: number;

	constructor(maxBytesPerAttachment: number = 10 * 1024 * 1024) {
		this.baseDir = path.join(app.getPath('userData'), 'attachments');
		this.maxBytesPerAttachment = maxBytesPerAttachment;
	}

	private buildAttachmentDir(chatId: string): string {
		return path.join(this.baseDir, chatId);
	}

	async saveAttachment(chatId: string, originalName: string, mimeType: string | undefined, dataBase64: string): Promise<AttachmentMeta> {
		const safeName = sanitizeFilename(originalName || 'attachment');
		const id = randomUUID();
		const finalMime = (mimeType && mimeType.trim() !== '') ? mimeType : guessMimeTypeFromName(safeName);

		const buf = Buffer.from(dataBase64, 'base64');
		if (buf.length > this.maxBytesPerAttachment) {
			throw new Error(`Attachment is too large. Max size is ${Math.round(this.maxBytesPerAttachment / (1024 * 1024))} MB.`);
		}

		const dir = this.buildAttachmentDir(chatId);
		await fs.mkdir(dir, {recursive: true});

		const storedFilename = `${id}_${safeName}`;
		const storedPath = path.join(dir, storedFilename);
		await fs.writeFile(storedPath, buf);

		return {
			id,
			originalName: safeName,
			mimeType: finalMime,
			sizeBytes: buf.length,
			storedPath,
		};
	}

	async getImageDataUrl(storedPath: string, mimeType: string): Promise<string> {
		const buf = await fs.readFile(storedPath);
		const base64 = buf.toString('base64');
		return `data:${mimeType};base64,${base64}`;
	}

	async openAttachment(storedPath: string): Promise<{ success: boolean; error?: string }> {
		const result = await shell.openPath(storedPath);
		if (result) {
			return {success: false, error: result};
		}
		return {success: true};
	}

	async readAttachmentBuffer(storedPath: string): Promise<Buffer> {
		return await fs.readFile(storedPath);
	}

	async extractTextForClaude(storedPath: string, mimeType: string, maxChars: number = 40_000): Promise<{ text: string; truncated: boolean }> {
		const lowerMime = (mimeType || '').toLowerCase();
		const isTextLike =
			lowerMime.startsWith('text/')
			|| lowerMime === 'application/json'
			|| lowerMime === 'application/xml'
			|| lowerMime === 'application/x-yaml'
			|| lowerMime === 'application/yaml'
			|| lowerMime === 'text/csv';

		if (!isTextLike) {
			return {text: '', truncated: false};
		}

		const raw = await fs.readFile(storedPath, 'utf-8');
		if (raw.length <= maxChars) {
			return {text: raw, truncated: false};
		}
		return {text: raw.slice(0, maxChars), truncated: true};
	}
}

