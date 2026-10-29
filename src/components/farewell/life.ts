import type {Chat} from '../../types';

// What the funeral knows about the supporter's time with Jørgen, read from their own chats.

export interface Question {
	text: string;
	askedAt: Date;
}

export interface Life {
	/** Oldest first. */
	questions: Question[];
	chatCount: number;
	systemCount: number;
	topSystem: string;
	born: Date | null;
}

export const NO_LIFE: Life = {questions: [], chatCount: 0, systemCount: 0, topSystem: '', born: null};

const DAY_STARTS_AT = 5 * 60;
const EVENING_AT    = 18 * 60;

export function readLife(chats: Chat[]): Life {
	const questions = chats
		.flatMap((chat) => chat.messages
			.filter((message) => message.role === 'user')
			.map((message) => ({text: message.content.replace(/\s+/g, ' ').trim(), askedAt: new Date(message.timestamp)})))
		.filter((question) => question.text !== '' && !Number.isNaN(question.askedAt.getTime()))
		.sort((a, b) => a.askedAt.getTime() - b.askedAt.getTime());

	const chatsPerSystem = new Map<string, number>();
	for (const chat of chats) {
		if (chat.systemName) {
			chatsPerSystem.set(chat.systemName, (chatsPerSystem.get(chat.systemName) ?? 0) + 1);
		}
	}
	const born = chats.reduce<Date | null>((earliest, chat) => {
		const createdAt = new Date(chat.createdAt);
		return !earliest || createdAt < earliest ? createdAt : earliest;
	}, null);

	return {
		questions,
		chatCount  : chats.length,
		systemCount: chatsPerSystem.size,
		topSystem  : [...chatsPerSystem].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
		born,
	};
}

export function shorten(text: string, length: number): string {
	return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

/** The question asked latest in the day, if after 18:00; the day runs to 05:00, so the small hours count as latest. */
export function nightOwl(questions: Question[]): Question | null {
	const lateness = (question: Question): number => (question.askedAt.getHours() * 60 + question.askedAt.getMinutes() - DAY_STARTS_AT + 24 * 60) % (24 * 60);
	const latest   = questions.reduce<Question | null>((best, question) => (!best || lateness(question) > lateness(best) ? question : best), null);
	return latest && lateness(latest) >= EVENING_AT - DAY_STARTS_AT ? latest : null;
}
