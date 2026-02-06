import React, {createContext, JSX, useContext, useEffect, useMemo, useRef, useState} from 'react';
import type {AttachmentMeta, Message} from '../types';

export type AiStreamStatus = 'idle' | 'running' | 'stopping' | 'error';

export interface ChatStreamState {
	chatId: string;
	streamId: string;
	status: AiStreamStatus;
	startedAtMs: number;
	lastEventAtMs: number;
	partialText: string;
	inTextMessage: boolean;
	hasStreamedContent: boolean;
	progressStatus: string;
	error?: string;
}

export interface SendAiMessageInput {
	chatId: string;
	message: string;
	databases: string[];
	history?: Array<{ role: string; content: string }>;
	chatContext?: { databaseName?: string; dbHost?: string; githubBranch?: string };
	attachments?: AttachmentMeta[];
}

interface AiStreamContextValue {
	streamsByChatId: Map<string, ChatStreamState>;
	isChatRunning: (chatId: string) => boolean;
	getChatStreamState: (chatId: string) => ChatStreamState | null;
	startChatStream: (input: SendAiMessageInput) => Promise<{ streamId: string }>;
	stopChatStream: (chatId: string) => Promise<void>;
}

const AiStreamContext = createContext<AiStreamContextValue | null>(null);

export function AiStreamProvider({children}: { children: React.ReactNode }): JSX.Element {
	const [streamsByChatId, setStreamsByChatId] = useState<Map<string, ChatStreamState>>(new Map());
	const streamIdToChatIdRef                   = useRef<Map<string, string>>(new Map());

	useEffect(() => {
		const offEvent = window.electronAPI.onAiEvent((payload) => {
			const chatId = streamIdToChatIdRef.current.get(payload.streamId);
			if (!chatId) {
				return;
			}
			const aiEvent = payload.event;
			if (!aiEvent || !aiEvent.type) {
				return;
			}
			if (aiEvent.type === 'TEXT_MESSAGE_START') {
				// Treat as a boundary hint; never reset text if we already have content.
				setStreamsByChatId((prev) => {
					const current = prev.get(chatId);
					if (!current) {
						return prev;
					}
					// If the event includes a role and it's not assistant, ignore.
					if (aiEvent.role && String(aiEvent.role).toLowerCase() !== 'assistant') {
						return prev;
					}
					const next = new Map(prev);
					next.set(chatId, {
						...current,
						inTextMessage: true,
						lastEventAtMs: Date.now(),
					});
					return next;
				});
				return;
			}
			if (aiEvent.type === 'TEXT_MESSAGE_END') {
				setStreamsByChatId((prev) => {
					const current = prev.get(chatId);
					if (!current) {
						return prev;
					}
					// If the event includes a role and it's not assistant, ignore.
					if (aiEvent.role && String(aiEvent.role).toLowerCase() !== 'assistant') {
						return prev;
					}
					const next = new Map(prev);
					next.set(chatId, {
						...current,
						inTextMessage: false,
						lastEventAtMs: Date.now(),
					});
					return next;
				});
				return;
			}
			if (aiEvent.type === 'TEXT_MESSAGE_CONTENT' && typeof aiEvent.delta === 'string') {
				setStreamsByChatId((prev) => {
					const current = prev.get(chatId);
					if (!current) {
						return prev;
					}
					const next        = new Map(prev);
					const partialText = current.partialText + aiEvent.delta;
					next.set(chatId, {
						...current,
						partialText,
						hasStreamedContent: current.hasStreamedContent || partialText.trim() !== '',
						// If we never saw START events, we still treat deltas as an active message.
						inTextMessage: true,
						lastEventAtMs: Date.now(),
					});
					return next;
				});
			}
		});

		const offFinished = window.electronAPI.onAiStreamFinished(async (payload) => {
			const chatId = streamIdToChatIdRef.current.get(payload.streamId);
			if (!chatId) {
				return;
			}

			// Persist the final assistant message even if the chat view is not open.
			try {
				const chat             = await window.electronAPI.getChat(chatId);
				const existingMessages = (chat?.messages || []).map((m) => ({
					role           : m.role,
					content        : m.content,
					detailedContent: (m as any).detailedContent,
					timestamp      : m.timestamp,
					attachments    : (m as any).attachments,
				}));

				const assistantMessage: any = {
					role           : 'assistant',
					content        : payload.result.shortAnswer,
					detailedContent: payload.result.detailedAnswer || undefined,
					timestamp      : new Date().toISOString(),
				};

				const updated = [...existingMessages, assistantMessage];
				await window.electronAPI.updateChat(chatId, updated, payload.result.suggestedTitle ? {title: payload.result.suggestedTitle} : undefined);
			} catch {
				// Non-fatal: the UI can still show streamed content; persistence can be retried by refresh.
			}

			setStreamsByChatId((prev) => {
				if (!prev.has(chatId)) {
					return prev;
				}
				const next = new Map(prev);
				next.delete(chatId);
				return next;
			});
			streamIdToChatIdRef.current.delete(payload.streamId);
		});

		const offError = window.electronAPI.onAiStreamError((payload) => {
			const chatId = streamIdToChatIdRef.current.get(payload.streamId);
			if (!chatId) {
				return;
			}
			setStreamsByChatId((prev) => {
				const current = prev.get(chatId);
				if (!current) {
					return prev;
				}
				const next = new Map(prev);
				next.set(chatId, {
					...current,
					status       : 'error',
					error        : payload.error,
					lastEventAtMs: Date.now(),
				});
				return next;
			});
		});

		const offProgress = window.electronAPI.onMessageProgress((payload: any) => {
			const maybeChatId   = payload && typeof payload === 'object' ? payload.chatId : null;
			const maybeStreamId = payload && typeof payload === 'object' ? payload.streamId : null;
			const status        = payload && typeof payload === 'object' ? payload.status : String(payload ?? '');
			if (!maybeChatId || !maybeStreamId) {
				return;
			}
			const chatId   = String(maybeChatId);
			const streamId = String(maybeStreamId);
			if (streamIdToChatIdRef.current.get(streamId) !== chatId) {
				return;
			}
			setStreamsByChatId((prev) => {
				const current = prev.get(chatId);
				if (!current) {
					return prev;
				}
				const next = new Map(prev);
				next.set(chatId, {
					...current,
					progressStatus: status,
					lastEventAtMs : Date.now(),
				});
				return next;
			});
		});

		return () => {
			offEvent();
			offFinished();
			offError();
			offProgress();
		};
	}, []);

	const value = useMemo<AiStreamContextValue>(() => {
		return {
			streamsByChatId,
			isChatRunning     : (chatId: string) => {
				const state = streamsByChatId.get(chatId);
				return !!state && (state.status === 'running' || state.status === 'stopping');
			},
			getChatStreamState: (chatId: string) => streamsByChatId.get(chatId) || null,
			startChatStream   : async (input: SendAiMessageInput) => {
				const now = Date.now();

				// Persist user message immediately so it shows in history even if user navigates away.
				try {
					const chat             = await window.electronAPI.getChat(input.chatId);
					const existingMessages = (chat?.messages || []).map((m) => ({
						role           : m.role,
						content        : m.content,
						detailedContent: (m as any).detailedContent,
						timestamp      : m.timestamp,
						attachments    : (m as any).attachments,
					}));

					const userMessage: any = {
						role       : 'user',
						content    : input.message,
						timestamp  : new Date().toISOString(),
						attachments: input.attachments && input.attachments.length > 0 ? input.attachments : undefined,
					};

					await window.electronAPI.updateChat(input.chatId, [...existingMessages, userMessage]);
				} catch {
					// Non-fatal: streaming can still proceed.
				}

				const {streamId} = await window.electronAPI.startAiStream(
					input.chatId,
					input.message,
					input.databases,
					input.history,
					input.chatContext,
					input.attachments,
				);

				streamIdToChatIdRef.current.set(streamId, input.chatId);

				setStreamsByChatId((prev) => {
					const next = new Map(prev);
					next.set(input.chatId, {
						chatId            : input.chatId,
						streamId,
						status            : 'running',
						startedAtMs       : now,
						lastEventAtMs     : now,
						partialText       : '',
						inTextMessage     : false,
						hasStreamedContent: false,
						progressStatus    : 'Processing...',
					});
					return next;
				});

				return {streamId};
			},
			stopChatStream    : async (chatId: string) => {
				const state = streamsByChatId.get(chatId);
				if (!state || !state.streamId) {
					return;
				}
				setStreamsByChatId((prev) => {
					const current = prev.get(chatId);
					if (!current) {
						return prev;
					}
					const next = new Map(prev);
					next.set(chatId, {...current, status: 'stopping', progressStatus: 'Stopping...'});
					return next;
				});
				await window.electronAPI.stopAiStream(state.streamId);
			},
		};
	}, [streamsByChatId]);

	return (
		<AiStreamContext.Provider value={value}>
			{children}
		</AiStreamContext.Provider>
	);
}

export function useAiStreams(): AiStreamContextValue {
	const ctx = useContext(AiStreamContext);
	if (!ctx) {
		throw new Error('useAiStreams must be used within AiStreamProvider');
	}
	return ctx;
}

export function buildStreamAssistantMessage(stream: ChatStreamState): Message {
	return {
		role     : 'assistant',
		content  : stream.partialText,
		timestamp: new Date(stream.lastEventAtMs),
	};
}

