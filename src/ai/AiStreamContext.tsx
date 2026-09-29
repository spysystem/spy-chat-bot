import React, {createContext, JSX, useContext, useEffect, useMemo, useRef, useState} from 'react';
import type {AttachmentMeta} from '../types';

type AiStreamStatus = 'idle' | 'running' | 'stopping' | 'error';

export interface ChatStreamState {
	chatId: string;
	streamId: string;
	status: AiStreamStatus;
	startedAtMs: number;
	lastEventAtMs: number;
	partialText: string;
	currentMessageId?: string;
	inTextMessage: boolean;
	hasStreamedContent: boolean;
	progressStatus: string;
	error?: string;
}

interface SendAiMessageInput {
	chatId: string;
	message: string;
	databases: string[];
	history?: Array<{ role: string; content: string }>;
	chatContext?: { databaseName?: string; dbHost?: string; githubBranch?: string };
	attachments?: AttachmentMeta[];
}

interface ClarificationRequest {
	chatId: string;
	question: string;
	options?: string[];
	allowFreeText?: boolean;
}

interface AiStreamContextValue {
	streamsByChatId: Map<string, ChatStreamState>;
	clarificationByChatId: Map<string, ClarificationRequest>;
	isChatRunning: (chatId: string) => boolean;
	getChatStreamState: (chatId: string) => ChatStreamState | null;
	getClarificationRequest: (chatId: string) => ClarificationRequest | null;
	startChatStream: (input: SendAiMessageInput) => Promise<{ streamId: string }>;
	stopChatStream: (chatId: string) => Promise<void>;
	submitClarification: (chatId: string, response: string, attachments?: AttachmentMeta[]) => Promise<void>;
}

const AiStreamContext = createContext<AiStreamContextValue | null>(null);

export function AiStreamProvider({children}: { children: React.ReactNode }): JSX.Element {
	const [streamsByChatId, setStreamsByChatId]             = useState<Map<string, ChatStreamState>>(new Map());
	const [clarificationByChatId, setClarificationByChatId] = useState<Map<string, ClarificationRequest>>(new Map());
	const streamIdToChatIdRef                               = useRef<Map<string, string>>(new Map());
	const streamIdToInputRef                                = useRef<Map<string, SendAiMessageInput>>(new Map());
	const clarificationInputByChatIdRef                     = useRef<Map<string, SendAiMessageInput>>(new Map());

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
				// Each model turn starts a new text message. Text written before a tool call is a
				// progress note, so a new turn replaces it; the last turn's text is the answer.
				setStreamsByChatId((prev) => {
					const current = prev.get(chatId);
					if (!current) {
						return prev;
					}
					// If the event includes a role, and it's not assistant, ignore.
					if (aiEvent.role && String(aiEvent.role).toLowerCase() !== 'assistant') {
						return prev;
					}
					const isNewMessage = !!aiEvent.messageId && aiEvent.messageId !== current.currentMessageId;
					const next         = new Map(prev);
					next.set(chatId, {
						...current,
						partialText     : isNewMessage ? '' : current.partialText,
						currentMessageId: aiEvent.messageId ?? current.currentMessageId,
						inTextMessage   : true,
						lastEventAtMs   : Date.now(),
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
					// If the event includes a role, and it's not assistant, ignore.
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
						// Show partial content while streaming for faster perceived responsiveness.
						hasStreamedContent: partialText.length > 0,
						inTextMessage     : true,
						lastEventAtMs     : Date.now(),
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

			// Persist final message before clearing stream state to avoid race conditions
			// where the UI refreshes before the assistant message is stored.
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
				// Non-fatal: persistence can be recovered by refresh.
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
			streamIdToInputRef.current.delete(payload.streamId);
		});

		const offClarification = window.electronAPI.onAiAskingClarification(async (payload) => {
			const chatId = payload.chatId;
			streamIdToChatIdRef.current.delete(payload.streamId);

			// Persist the assistant question so it appears in the chat
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
					role     : 'assistant',
					content  : payload.question,
					timestamp: new Date().toISOString(),
				};

				await window.electronAPI.updateChat(chatId, [...existingMessages, assistantMessage]);
			} catch {
				// Non-fatal
			}

			// Store input for when user submits (need databases, history, etc.)
			const input = streamIdToInputRef.current.get(payload.streamId);
			streamIdToInputRef.current.delete(payload.streamId);
			if (input) {
				clarificationInputByChatIdRef.current.set(chatId, input);
			}

			setStreamsByChatId((prev) => {
				const next = new Map(prev);
				next.delete(chatId);
				return next;
			});

			setClarificationByChatId((prev) => {
				const next = new Map(prev);
				next.set(chatId, {
					chatId       : payload.chatId,
					question     : payload.question,
					options      : payload.options,
					allowFreeText: payload.allowFreeText !== false,
				});
				return next;
			});
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
			offClarification();
			offError();
			offProgress();
		};
	}, []);

	const value = useMemo<AiStreamContextValue>(() => {
		return {
			streamsByChatId,
			clarificationByChatId,
			isChatRunning          : (chatId: string) => {
				const state = streamsByChatId.get(chatId);
				return !!state && (state.status === 'running' || state.status === 'stopping');
			},
			getChatStreamState     : (chatId: string) => streamsByChatId.get(chatId) || null,
			getClarificationRequest: (chatId: string) => clarificationByChatId.get(chatId) || null,
			startChatStream        : async (input: SendAiMessageInput) => {
				const now = Date.now();

				const {streamId} = await window.electronAPI.startAiStream(
					input.chatId,
					input.message,
					input.databases,
					input.history,
					input.chatContext,
					input.attachments,
				);

				streamIdToChatIdRef.current.set(streamId, input.chatId);
				streamIdToInputRef.current.set(streamId, input);

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

				// Persist user message in background to avoid delaying stream start.
				void (async () => {
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
				})();

				return {streamId};
			},
			stopChatStream         : async (chatId: string) => {
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
			submitClarification    : async (chatId: string, response: string, attachments?: AttachmentMeta[]) => {
				const clarification = clarificationByChatId.get(chatId);
				const input         = clarificationInputByChatIdRef.current.get(chatId);
				if (!clarification || !input) {
					return;
				}
				clarificationInputByChatIdRef.current.delete(chatId);
				setClarificationByChatId((prev) => {
					const next = new Map(prev);
					next.delete(chatId);
					return next;
				});

				// Persist user response
				const chat             = await window.electronAPI.getChat(chatId);
				const existingMessages = (chat?.messages || []).map((m) => ({
					role           : m.role,
					content        : m.content,
					detailedContent: (m as any).detailedContent,
					timestamp      : m.timestamp,
					attachments    : (m as any).attachments,
				}));

				const userMessage: any = {
					role       : 'user',
					content    : response,
					timestamp  : new Date().toISOString(),
					attachments: attachments && attachments.length > 0 ? attachments : undefined,
				};

				await window.electronAPI.updateChat(chatId, [...existingMessages, userMessage]);

				// Build history: [original user message, assistant question] - we already added assistant in offClarification
				const history = existingMessages.map((m) => ({role: m.role, content: m.content}));

				const mergedAttachments = [
					...(input.attachments || []),
					...(attachments || []),
				].reduce((acc, item) => {
					if (!acc.some((existing) => existing.id === item.id)) {
						acc.push(item);
					}
					return acc;
				}, [] as AttachmentMeta[]);

				// Start new stream with clarification as context
				const {streamId} = await window.electronAPI.startAiStream(
					chatId,
					response,
					input.databases,
					history,
					input.chatContext,
					mergedAttachments.length > 0 ? mergedAttachments : undefined,
				);

				streamIdToChatIdRef.current.set(streamId, chatId);
				streamIdToInputRef.current.set(streamId, {
					...input,
					message    : response,
					history,
					attachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
				});

				setStreamsByChatId((prev) => {
					const next = new Map(prev);
					next.set(chatId, {
						chatId            : chatId,
						streamId,
						status            : 'running',
						startedAtMs       : Date.now(),
						lastEventAtMs     : Date.now(),
						partialText       : '',
						inTextMessage     : false,
						hasStreamedContent: false,
						progressStatus    : 'Processing...',
					});
					return next;
				});
			},
		};
	}, [streamsByChatId, clarificationByChatId]);

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


