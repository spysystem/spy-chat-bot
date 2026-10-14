import type {Message} from '../types';
import type {ChatStreamState} from './AiStreamContext';

const FOLLOW_UPS_FENCE = '```followups';

export function buildStreamAssistantMessage(stream: ChatStreamState): Message {
	return {
		role     : 'assistant',
		content  : hideFollowUps(stream.partialText),
		timestamp: new Date(stream.lastEventAtMs),
	};
}

/**
 * Cuts the follow-up block off a streaming answer; the main process strips it from the final
 * answer and the questions are shown as buttons. A partly streamed fence is cut too.
 */
function hideFollowUps(text: string): string {
	const start = text.indexOf(FOLLOW_UPS_FENCE);
	if (start !== -1) {
		return text.slice(0, start);
	}
	for (let length = FOLLOW_UPS_FENCE.length - 1; length >= 3; length--) {
		if (text.endsWith(FOLLOW_UPS_FENCE.slice(0, length))) {
			return text.slice(0, -length);
		}
	}
	return text;
}
