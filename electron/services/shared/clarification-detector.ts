export interface TextClarification {
	question: string;
	options: string[];
}

export function detectTextClarification(text: string): TextClarification | null {
	if (!text || text.length > 800) {
		return null;
	}
	const hasQuestion = /[?？]/.test(text)
		|| /\b(hvad|hvilken|hvilke|how|what|where|which|kan du|could you|do you|er det|is it|online|pos|ny|eksisterende)\b/i.test(text);
	if (!hasQuestion) {
		return null;
	}
	const lines   = text.split('\n').map((l) => l.trim()).filter(Boolean);
	const options = lines
		.filter((l) => /^(\d+[.)\s]|[-•*]\s)/.test(l))
		.map((l) => l.replace(/^(\d+[.)\s]|[-•*]\s)/, '').trim())
		.filter((l) => l.length > 0 && l.length < 80);
	if (options.length < 2 || options.length > 5) {
		return null;
	}
	const firstListIndex = lines.findIndex((l) => /^(\d+[.)\s]|[-•*]\s)/.test(l));
	const questionLines  = firstListIndex > 0 ? lines.slice(0, firstListIndex) : [lines[0]];
	const question       = questionLines.join(' ').replace(/[:]+$/, '').trim();
	if (!question) {
		return null;
	}
	return {question, options};
}
