import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// Kept free of Electron imports so the export can be run against any folder.

export const EXPORT_FORMAT         = 'spoerge-joergen-export';
export const EXPORT_FORMAT_VERSION = 1;

export interface AssistantExportOptions {
	/** Jørgen's own folder (`app.getPath('userData')`). */
	userDataDir: string;
	downloadsDir: string;
	appVersion: string;
	now?: Date;
}

export interface AssistantExportResult {
	filePath: string;
	exportedAt: string;
	chatCount: number;
	replyContactCount: number;
	attachmentCount: number;
	missingAttachmentCount: number;
}

interface NamedAttachment {
	chatId: string;
	id: string;
	originalName: string;
	mimeType: string;
	storedPath: string;
}

type MissingReason = 'missing' | 'unreadable';

interface MissingAttachment {
	chatId: string;
	id: string;
	originalName: string;
	reason: MissingReason;
}

/**
 * Writes the one file Admin's assistant imports ("Import from Spørge Jørgen"): chats.json and
 * reply-contacts.json as they are, plus each attachment a chat names. Nothing else from the folder
 * goes in (no settings, logins, query log, schema index or code).
 *
 * Layout (UTF-8, LF): one JSON object with its keys in a fixed order, one piece per line, so the
 * import can read it line by line or with a streaming JSON parser and never holds more than one
 * chat or attachment:
 *
 *   {
 *   "format": "spoerge-joergen-export",
 *   "formatVersion": 1,
 *   "appVersion": "1.8.0",
 *   "exportedAt": "2026-10-29T13:14:15.678Z",
 *   "chats": [
 *   {…one chat from chats.json…},
 *   {…}
 *   ],
 *   "replyContacts": [
 *   {…one contact from reply-contacts.json…}
 *   ],
 *   "attachments": [
 *   {"chatId": …, "id": …, "originalName": …, "mimeType": …, "sizeBytes": …, "dataBase64": …}
 *   ],
 *   "missingAttachments": [
 *   {"chatId": …, "id": …, "originalName": …, "reason": "missing" | "unreadable"}
 *   ]
 *   }
 *
 * Every element is written with JSON.stringify, so no piece holds a raw newline. Attachments come
 * after all chats; each is listed once (ids are unique), under the chat that names it first, and is
 * matched to its chat message by `id`. "missing" means not found in the attachments folder.
 */
export async function writeAssistantExport(options: AssistantExportOptions): Promise<AssistantExportResult> {
	const now            = options.now ?? new Date();
	const chats          = await readStore(options.userDataDir, 'chats.json');
	const replyContacts  = await readStore(options.userDataDir, 'reply-contacts.json');
	const attachments    = namedAttachments(chats);
	const attachmentsDir = path.join(options.userDataDir, 'attachments');
	const filePath       = await freeExportPath(options.downloadsDir, now);
	const partialPath    = `${filePath}.partial`;

	const stream = fs.createWriteStream(partialPath, {encoding: 'utf-8'});
	// Errors also reach each write's callback; without a listener they would crash the main process.
	stream.on('error', () => undefined);
	const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
		stream.write(text, (error) => (error ? reject(error) : resolve()));
	});

	let attachmentCount = 0;
	const missing: MissingAttachment[] = [];
	try {
		await write('{\n');
		await write(`"format": ${JSON.stringify(EXPORT_FORMAT)},\n`);
		await write(`"formatVersion": ${EXPORT_FORMAT_VERSION},\n`);
		await write(`"appVersion": ${JSON.stringify(options.appVersion)},\n`);
		await write(`"exportedAt": ${JSON.stringify(now.toISOString())},\n`);
		await writeArray(write, 'chats', chats, false);
		await writeArray(write, 'replyContacts', replyContacts, false);

		await write('"attachments": [\n');
		for (const attachment of attachments) {
			const read = await readAttachment(attachmentsDir, attachment);
			if (!read.data) {
				missing.push({chatId: attachment.chatId, id: attachment.id, originalName: attachment.originalName, reason: read.reason});
				continue;
			}
			await write(`${attachmentCount > 0 ? ',\n' : ''}${JSON.stringify({
				chatId      : attachment.chatId,
				id          : attachment.id,
				originalName: attachment.originalName,
				mimeType    : attachment.mimeType,
				sizeBytes   : read.data.length,
				dataBase64  : read.data.toString('base64'),
			})}`);
			attachmentCount++;
		}
		await write(`${attachmentCount > 0 ? '\n' : ''}],\n`);

		await writeArray(write, 'missingAttachments', missing, true);
		await write('}\n');
		await new Promise<void>((resolve, reject) => stream.end((error?: Error | null) => (error ? reject(error) : resolve())));
		await fsp.rename(partialPath, filePath);
	} catch (error) {
		stream.destroy();
		await fsp.rm(partialPath, {force: true});
		throw error;
	}

	return {
		filePath,
		exportedAt            : now.toISOString(),
		chatCount             : chats.length,
		replyContactCount     : replyContacts.length,
		attachmentCount,
		missingAttachmentCount: missing.length,
	};
}

/**
 * A store that does not exist yet is empty; one that cannot be read refuses the export. The stores
 * are rewritten in place while an answer streams, so an unparsable read is tried once more.
 */
async function readStore(userDataDir: string, fileName: string, retries: number = 1): Promise<unknown[]> {
	const unreadable = (reason: unknown): Error => new Error(`Could not read ${fileName}: ${reason instanceof Error ? reason.message : String(reason)}`);
	let text: string;
	try {
		text = await fsp.readFile(path.join(userDataDir, fileName), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw unreadable(error);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		if (retries > 0) {
			await new Promise((resolve) => setTimeout(resolve, 300));
			return readStore(userDataDir, fileName, retries - 1);
		}
		throw unreadable(error);
	}
	if (!Array.isArray(parsed)) {
		throw unreadable('not a list');
	}
	return parsed;
}

async function writeArray(write: (text: string) => Promise<void>, key: string, items: unknown[], last: boolean): Promise<void> {
	await write(`${JSON.stringify(key)}: [\n`);
	for (let i = 0; i < items.length; i++) {
		await write(`${JSON.stringify(items[i])}${i < items.length - 1 ? ',' : ''}\n`);
	}
	await write(last ? ']\n' : '],\n');
}

/** Each attachment the chats name, once, in the order they name them. */
function namedAttachments(chats: unknown[]): NamedAttachment[] {
	const seen  = new Set<string>();
	const named: NamedAttachment[] = [];
	for (const chat of chats as Array<{ id?: unknown; messages?: unknown }>) {
		if (typeof chat?.id !== 'string' || !Array.isArray(chat.messages)) {
			continue;
		}
		for (const message of chat.messages as Array<{ attachments?: unknown }>) {
			if (!Array.isArray(message?.attachments)) {
				continue;
			}
			for (const attachment of message.attachments as Array<Partial<NamedAttachment>>) {
				if (typeof attachment?.id !== 'string' || seen.has(attachment.id)) {
					continue;
				}
				seen.add(attachment.id);
				named.push({
					chatId      : chat.id,
					id          : attachment.id,
					originalName: typeof attachment.originalName === 'string' ? attachment.originalName : '',
					mimeType    : typeof attachment.mimeType === 'string' ? attachment.mimeType : 'application/octet-stream',
					storedPath  : typeof attachment.storedPath === 'string' ? attachment.storedPath : '',
				});
			}
		}
	}
	return named;
}

/**
 * Reads an attachment only from Jørgen's attachments folder: at its storedPath when that is inside
 * the folder, else by its file name under attachments/<chatId>/ (a folder moved since it was saved).
 */
async function readAttachment(attachmentsDir: string, attachment: NamedAttachment): Promise<{ data: Buffer; reason?: undefined } | { data?: undefined; reason: MissingReason }> {
	const fileName   = attachment.storedPath.split(/[\\/]/).pop() ?? '';
	const candidates = [attachment.storedPath, path.join(attachmentsDir, attachment.chatId, fileName)]
		.filter((candidate) => fileName !== '' && isInside(attachmentsDir, candidate))
		.map((candidate) => path.resolve(candidate));

	let reason: MissingReason = 'missing';
	for (const candidate of new Set(candidates)) {
		try {
			return {data: await fsp.readFile(candidate)};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				reason = 'unreadable';
			}
		}
	}
	return {reason};
}

function isInside(dir: string, filePath: string): boolean {
	if (!path.isAbsolute(filePath)) {
		return false;
	}
	const relative = path.relative(path.resolve(dir), path.resolve(filePath));
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** spoerge-joergen-export-<date>.json, or -2, -3 … when an export was already made that day. */
async function freeExportPath(downloadsDir: string, now: Date): Promise<string> {
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	for (let n = 1; ; n++) {
		const filePath = path.join(downloadsDir, `spoerge-joergen-export-${date}${n > 1 ? `-${n}` : ''}.json`);
		try {
			await fsp.access(filePath);
		} catch {
			return filePath;
		}
	}
}
