import {app} from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';

const MAX_STORED_EXAMPLES = 5;
const MAX_EXAMPLE_CHARS   = 6000;

/** How this support staff member writes to one person at a customer. */
export interface ReplyContact {
	systemKey: string;
	name: string;
	toneNote: string;
	/** Emails sent to this person, newest last: copied replies and pasted older emails. */
	examples: Array<{ text: string; savedAt: string }>;
	updatedAt: string;
}

export interface ReplyContactSummary {
	name: string;
	toneNote: string;
	exampleCount: number;
}

/**
 * Tone profiles per recipient, kept locally: the tone belongs to one staff member's relationship
 * with the person, so profiles are not shared.
 */
export class ReplyContactService {
	// Serialises read-modify-write cycles so two quick saves don't overwrite each other.
	private queue: Promise<unknown> = Promise.resolve();

	async list(systemKey: string): Promise<ReplyContactSummary[]> {
		const contacts = await this.load();
		return contacts
			.filter((c) => c.systemKey === systemKey)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.map((c) => ({name: c.name, toneNote: c.toneNote, exampleCount: c.examples.length}));
	}

	async get(systemKey: string, name: string): Promise<ReplyContact | null> {
		const key = normalizeName(name);
		return (await this.load()).find((c) => c.systemKey === systemKey && normalizeName(c.name) === key) ?? null;
	}

	async saveToneNote(systemKey: string, name: string, toneNote: string): Promise<void> {
		await this.update(systemKey, name, (contact) => {
			contact.toneNote = toneNote.trim();
		});
	}

	async addExample(systemKey: string, name: string, text: string): Promise<void> {
		const trimmed = text.trim().slice(0, MAX_EXAMPLE_CHARS);
		if (!trimmed) {
			return;
		}
		await this.update(systemKey, name, (contact) => {
			contact.examples = [
				...contact.examples.filter((e) => e.text !== trimmed),
				{text: trimmed, savedAt: new Date().toISOString()},
			].slice(-MAX_STORED_EXAMPLES);
		});
	}

	async clearExamples(systemKey: string, name: string): Promise<void> {
		await this.update(systemKey, name, (contact) => {
			contact.examples = [];
		});
	}

	private update(systemKey: string, name: string, change: (contact: ReplyContact) => void): Promise<void> {
		const displayName = name.trim();
		if (!displayName) {
			return Promise.resolve();
		}
		const run  = async (): Promise<void> => {
			const contacts = await this.load();
			const key      = normalizeName(displayName);
			let contact    = contacts.find((c) => c.systemKey === systemKey && normalizeName(c.name) === key);
			if (!contact) {
				contact = {systemKey, name: displayName, toneNote: '', examples: [], updatedAt: ''};
				contacts.push(contact);
			}
			change(contact);
			contact.updatedAt = new Date().toISOString();
			await fs.writeFile(this.filePath(), JSON.stringify(contacts, null, 2), 'utf-8');
		};
		const task = this.queue.then(run, run);
		this.queue = task.catch(() => undefined);
		return task;
	}

	private async load(): Promise<ReplyContact[]> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.filePath(), 'utf-8'));
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	private filePath(): string {
		return path.join(app.getPath('userData'), 'reply-contacts.json');
	}
}

function normalizeName(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
