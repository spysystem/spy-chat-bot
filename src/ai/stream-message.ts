import type {Message} from '../types';
import type {ChatStreamState} from './AiStreamContext';

export function buildStreamAssistantMessage(stream: ChatStreamState): Message {
	return {
		role     : 'assistant',
		content  : stream.partialText,
		timestamp: new Date(stream.lastEventAtMs),
	};
}
