import {LATENCY_FLAGS} from '../latency-flags';

function normalizeContextText(text: string, maxChars: number = 280): string {
	return String(text || '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, maxChars);
}

export function compactConversationHistory(
	history: Array<{ role: string; content: string }>,
	maxMessages: number = 14,
): Array<{ role: string; content: string }> {
	if (!LATENCY_FLAGS.enableContextCompaction || history.length <= maxMessages) {
		return history;
	}

	const sanitizedHistory = history.filter((m) => normalizeContextText(m.content).length > 0);
	if (sanitizedHistory.length <= maxMessages) {
		return sanitizedHistory;
	}

	const keepFirst   = Math.min(2, Math.max(0, maxMessages - 7));
	const summarySlot = 1;
	const keepLast    = Math.max(6, maxMessages - keepFirst - summarySlot);
	const head        = sanitizedHistory.slice(0, keepFirst);
	const middleStart = keepFirst;
	const middleEnd   = Math.max(middleStart, sanitizedHistory.length - keepLast);
	const middle      = sanitizedHistory.slice(middleStart, middleEnd);
	const tail        = sanitizedHistory.slice(-keepLast);
	const summary     = middle
		.slice(-10)
		.map((m) => `${m.role}: ${normalizeContextText(m.content, 320)}`)
		.join('\n');
	if (!summary) {
		return [...head, ...tail];
	}
	return [
		...head,
		{
			role   : 'assistant',
			content: `[Earlier context summary]\n${summary}`,
		},
		...tail,
	];
}

export function buildFollowUpRetrievalQuery(
	history: Array<{ role: string; content: string }> | undefined,
	userMessage: string,
	maxHistoryMessages: number = 4,
): string {
	const recentContext = (history || [])
		.filter((m) => normalizeContextText(m.content).length > 0)
		.filter((m) => !String(m.content).startsWith('[Earlier context summary]'))
		.slice(-maxHistoryMessages)
		.map((m) => `${m.role}: ${normalizeContextText(m.content, 260)}`);

	return [...recentContext, `user: ${normalizeContextText(userMessage, 320)}`]
		.filter(Boolean)
		.join('\n');
}

export function formatRecentConversationForSummary(
	history: Array<{ role: string; content: string }> | undefined,
	maxHistoryMessages: number = 6,
): string {
	const recentMessages = (history || [])
		.filter((m) => normalizeContextText(m.content).length > 0)
		.slice(-maxHistoryMessages)
		.map((m) => `${m.role}: ${normalizeContextText(m.content, 320)}`);

	return recentMessages.join('\n');
}
