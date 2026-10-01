import {Fragment, JSX, useEffect, useMemo, useRef, useState} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import {useAiStreams} from '../ai/AiStreamContext';
import {buildStreamAssistantMessage} from '../ai/stream-message';
import './ChatView.css';
import type {AiQualityProfile, AttachmentMeta, Chat, ChatUpdate, DatabaseConfig, Message, SystemDirectorySystem} from '../types';
import {resolveSystemBranch} from '../../electron/services/shared/release-branch';
import {MarkdownPre} from './ChartBlock';
import {Icon, type IconName} from './Icon';
import {type TranslationKey, useI18n} from '../i18n';
import 'highlight.js/styles/github-dark.css';

interface ChatViewProps {
	chatId: string;
	onChatUpdate: () => void;
}

export function ChatView({chatId, onChatUpdate}: ChatViewProps): JSX.Element {
	const [messages, setMessages]                         = useState<Message[]>([]);
	const [inputValue, setInputValue]                     = useState('');
	const [isSending, setIsSending]                       = useState(false);
	const [connection, setConnection]                     = useState<DatabaseConfig | null>(null);
	const [databaseName, setDatabaseName]                 = useState<string>('');
	const [pendingAttachments, setPendingAttachments]     = useState<AttachmentMeta[]>([]);
	const [attachmentPreviewMap, setAttachmentPreviewMap] = useState<Map<string, string>>(new Map()); // storedPath -> dataUrl
	const [attachmentError, setAttachmentError]           = useState<string>('');
	const [hasApiKey, setHasApiKey]                       = useState(false);
	const [aiQualityProfile, setAiQualityProfile]         = useState<AiQualityProfile>('maximum_accuracy');
	const [userName, setUserName]                         = useState<string>('');
	const [isInitialized, setIsInitialized]               = useState(false);
	const [expandedMessageMap, setExpandedMessageMap]     = useState<Map<number, boolean>>(new Map());
	const [selectedChat, setSelectedChat]                 = useState<Chat | null>(null);

	// System selector state (per chat)
	const [systems, setSystems]                     = useState<SystemDirectorySystem[]>([]);
	const [systemsLoading, setSystemsLoading]       = useState<boolean>(false);
	const [systemsError, setSystemsError]           = useState<string>('');
	const [systemSearch, setSystemSearch]           = useState<string>('');
	const [showSystemResults, setShowSystemResults] = useState<boolean>(false);
	const [highlightedSystem, setHighlightedSystem] = useState<number>(0);
	const [filterActive, setFilterActive]           = useState<boolean>(true);
	const [filterRestore, setFilterRestore]         = useState<boolean>(false);
	const [filterDev, setFilterDev]                 = useState<boolean>(false);
	const [copiedIndex, setCopiedIndex]             = useState<number | null>(null);
	const [isDragging, setIsDragging]               = useState<boolean>(false);

	const systemSelectorReference = useRef<HTMLDivElement>(null);
	const systemInputReference    = useRef<HTMLInputElement>(null);
	const messagesEndReference    = useRef<HTMLDivElement>(null);
	// Follow new output only while the user is at the bottom, so scrolling up to read is not interrupted.
	const stickToBottomReference  = useRef<boolean>(true);
	const previousChatIdReference = useRef<string>(chatId);
	const textareaReference       = useRef<HTMLTextAreaElement>(null);
	const fileInputReference      = useRef<HTMLInputElement>(null);
	const {
			  getChatStreamState,
			  startChatStream,
			  stopChatStream,
			  getClarificationRequest,
			  submitClarification,
		  }                       = useAiStreams();
	const {t, locale, translateProgress, chatTitle} = useI18n();
	const streamState             = getChatStreamState(chatId);
	const clarificationRequest    = getClarificationRequest(chatId);
	const isStreamRunning         = !!streamState && (streamState.status === 'running' || streamState.status === 'stopping');
	const progressStatus          = streamState?.progressStatus || '';

	const DEV_SQL_HOST = 'dev2.spysystem.dk';

	const getDraftStorageKey = (id: string): string => `chat_draft_${id}`;

	const loadDraft = (id: string): string => {
		try {
			return localStorage.getItem(getDraftStorageKey(id)) ?? '';
		} catch {
			return '';
		}
	};

	const saveDraft = (id: string, value: string): void => {
		try {
			localStorage.setItem(getDraftStorageKey(id), value);
		} catch {
			// Ignore storage failures (e.g., disabled storage, quota issues).
		}
	};

	const clearDraft = (id: string): void => {
		try {
			localStorage.removeItem(getDraftStorageKey(id));
		} catch {
			// Ignore storage failures.
		}
	};

	useEffect(() => {
		async function initialize() {
			setIsInitialized(false);
			await loadConnection();
			await Promise.all([loadAiSettings(), checkApiKey()]);
			await loadUserName();
			// Force window focus
			await window.electronAPI.focusWindow();
			// Small delay to ensure everything is ready
			setTimeout(() => {
				setIsInitialized(true);
			}, 200);
		}

		initialize();
	}, [chatId]);

	useEffect(() => {
		// Restore any unsent draft text for this chat.
		const draft = loadDraft(chatId);
		if (draft && draft.trim() !== '') {
			setInputValue(draft);
		}
	}, [chatId]);

	useEffect(() => {
		// Persist drafts so navigation/chat switching doesn't lose unsent text.
		const handle = setTimeout(() => {
			if (inputValue.trim() === '') {
				clearDraft(chatId);
				return;
			}
			saveDraft(chatId, inputValue);
		}, 150);

		return () => clearTimeout(handle);
	}, [chatId, inputValue]);

	useEffect(() => {
		// Load chat messages when chatId changes or on mount
		async function loadChatData() {
			const chat = await window.electronAPI.getChat(chatId);
			setSelectedChat(chat);
			if (chat) {
				// Convert string timestamps to Date objects
				const loadedMessages = chat.messages.map((m) => ({
					...m,
					timestamp: new Date(m.timestamp),
				}));
				setMessages(loadedMessages);
				setExpandedMessageMap(new Map());
				setPendingAttachments([]);
				setAttachmentError('');

				// Set the database name for this chat
				setDatabaseName(chat.databaseName ?? '');
				setSystemSearch('');
				setFilterDev(!!chat.isDevMode);
				setFilterRestore(!!chat.isRestore);
				setFilterActive(!chat.isRestore);
			} else {
				setMessages([]);
				setExpandedMessageMap(new Map());
				setDatabaseName('');
				setSystemSearch('');
				setFilterDev(false);
				setFilterRestore(false);
				setFilterActive(true);
			}
		}

		loadChatData();
		previousChatIdReference.current = chatId;
	}, [chatId]);

	const previousStreamRunningRef = useRef<boolean>(false);
	useEffect(() => {
		const wasRunning                 = previousStreamRunningRef.current;
		const nowRunning                 = isStreamRunning;
		previousStreamRunningRef.current = nowRunning;
		if (wasRunning && !nowRunning) {
			// Reload persisted messages when stream completes to ensure final assistant
			// response is visible immediately in this view.
			void (async () => {
				const chat = await window.electronAPI.getChat(chatId);
				setSelectedChat(chat);
				if (chat) {
					const loadedMessages = chat.messages.map((m) => ({
						...m,
						timestamp: new Date(m.timestamp),
					}));
					setMessages(loadedMessages);
				}
				onChatUpdate();
				textareaReference.current?.focus();
			})();
		}
	}, [chatId, isStreamRunning, onChatUpdate]);

	useEffect(() => {
		const handler = (event: MouseEvent) => {
			const el = systemSelectorReference.current;
			if (!el) {
				return;
			}
			if (event.target instanceof Node && el.contains(event.target)) {
				return;
			}
			setShowSystemResults(false);
		};

		// Use capture so it triggers even if a click is stopped.
		window.addEventListener('mousedown', handler, {capture: true});
		return () => window.removeEventListener('mousedown', handler, {capture: true} as any);
	}, []);

	useEffect(() => {
		let cancelled = false;

		async function loadSystems(): Promise<void> {
			if (filterDev) {
				return;
			}
			setSystemsError('');
			setSystemsLoading(true);
			try {
				const list = await window.electronAPI.getSystems(['active', 'restore']);
				if (!cancelled) {
					setSystems(list);
				}
			} catch (error) {
				if (!cancelled) {
					setSystemsError(error instanceof Error ? error.message : String(error));
				}
			} finally {
				if (!cancelled) {
					setSystemsLoading(false);
				}
			}
		}

		loadSystems();
		return () => {
			cancelled = true;
		};
	}, [filterDev, chatId]);

	const scrollTimerReference = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (scrollTimerReference.current) {
			clearTimeout(scrollTimerReference.current);
		}
		scrollTimerReference.current = setTimeout(() => {
			if (!stickToBottomReference.current) {
				return;
			}
			messagesEndReference.current?.scrollIntoView({behavior: 'smooth'});
		}, 80);
		return () => {
			if (scrollTimerReference.current) {
				clearTimeout(scrollTimerReference.current);
			}
		};
	}, [messages, streamState?.partialText]);

	useEffect(() => {
		// Focus textarea when component is ready and has API key
		if (hasApiKey && isInitialized) {
			// Use requestAnimationFrame for better timing
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					textareaReference.current?.focus();
				});
			});
		}
	}, [hasApiKey, isInitialized]);

	useEffect(() => {
		// Auto-resize textarea based on content
		const textarea = textareaReference.current;
		if (textarea) {
			// Reset height to get accurate scrollHeight
			textarea.style.height = 'auto';
			// Set height to scrollHeight (capped by max-height in CSS)
			textarea.style.height = `${textarea.scrollHeight}px`;
		}
	}, [inputValue]);

	async function saveChatUpdate(update: ChatUpdate): Promise<void> {
		const messagesToSave = messages.map((m) => ({
			role           : m.role,
			content        : m.content,
			detailedContent: m.detailedContent,
			timestamp      : m.timestamp.toISOString(),
			attachments    : m.attachments,
		}));
		await window.electronAPI.updateChat(chatId, messagesToSave, update);
		// Refresh from disk to ensure UI always reflects persisted chat state.
		const refreshed = await window.electronAPI.getChat(chatId);
		setSelectedChat(refreshed);
		onChatUpdate();
	}


	async function loadConnection(): Promise<DatabaseConfig | null> {
		const configs = await window.electronAPI.getDatabaseConfigs();
		// Get the first (and only) connection
		const conn    = configs.length > 0 ? configs[0] : null;
		setConnection(conn);
		return conn;
	}

	async function loadAiSettings(): Promise<void> {
		setAiQualityProfile(await window.electronAPI.getAiQualityProfile());
	}

	async function checkApiKey(): Promise<void> {
		setHasApiKey(!!(await window.electronAPI.getApiKey()));
	}

	async function loadUserName(): Promise<void> {
		const name = await window.electronAPI.getUserName();
		if (name) {
			setUserName(name);
		}
	}

	function getServerDisplayName(host: string): string {
		// Remove .spysystem.dk suffix for display (show only "spy20" etc)
		return host.replace('.spysystem.dk', '');
	}

	async function saveMessages(updatedMessages: Message[]): Promise<void> {
		// Convert Date objects to ISO strings for storage
		const messagesToSave = updatedMessages.map((m) => ({
			role           : m.role,
			content        : m.content,
			detailedContent: m.detailedContent,
			timestamp      : m.timestamp.toISOString(),
			attachments    : m.attachments,
		}));

		await window.electronAPI.updateChat(chatId, messagesToSave);
		onChatUpdate();
	}

	const filteredSystems = useMemo(() => {
		if (filterDev) {
			return [];
		}

		const needle = systemSearch.trim().toLowerCase();
		return systems
			.filter((s) => {
				const matchesActive  = filterActive && !s.isDev && !s.isRestore;
				const matchesRestore = filterRestore && s.isRestore;
				return matchesActive || matchesRestore;
			})
			.filter((s) => {
				if (!needle) {
					return true;
				}
				return (
					s.name.toLowerCase().includes(needle) ||
					s.systemKey.toLowerCase().includes(needle) ||
					s.databaseName.toLowerCase().includes(needle) ||
					s.serverHost.toLowerCase().includes(needle)
				);
			})
	}, [filterActive, filterRestore, filterDev, systemSearch, systems]);

	async function selectSystem(system: SystemDirectorySystem): Promise<void> {
		const branch = resolveSystemBranch(system);
		setSystemSearch('');
		setDatabaseName(system.databaseName);
		setShowSystemResults(false);
		await saveChatUpdate({
			systemKey   : system.systemKey,
			systemName  : system.name,
			dbHost      : system.serverHost,
			release     : system.release,
			isRestore   : system.isRestore,
			isDevMode   : false,
			databaseName: system.databaseName,
			branch,
			systemUrl   : system.systemUrlWithProtocol,
		});
	}

	function setSystemFilterMode(mode: 'active' | 'restore'): void {
		setFilterActive(mode === 'active');
		setFilterRestore(mode === 'restore');
	}

	async function toggleDevMode(next: boolean): Promise<void> {
		setFilterDev(next);
		if (next) {
			setFilterActive(false);
			setFilterRestore(false);
		} else {
			setFilterActive(true);
			setFilterRestore(false);
		}
		if (next) {
			await saveChatUpdate({
				isDevMode: true,
				dbHost   : DEV_SQL_HOST,
				branch   : '',
				// Clear branch because dev DB selection does not guarantee a matching code branch.
				systemKey : '',
				systemName: 'Dev',
				release   : '',
				isRestore : false,
			});
		} else {
			await saveChatUpdate({
				isDevMode: false,
				// Keep previous selection until user chooses a system.
			});
		}
	}

	async function saveDevDatabaseNameOnly(): Promise<void> {
		if (!filterDev) {
			return;
		}
		await saveChatUpdate({
			isDevMode   : true,
			dbHost      : DEV_SQL_HOST,
			databaseName: databaseName.trim(),
		});
	}

	function toBase64(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let binary  = '';
		for (let i = 0; i < bytes.byteLength; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}

	async function addFileAsAttachment(file: File): Promise<void> {
		setAttachmentError('');
		if (file.size > 10 * 1024 * 1024) {
			setAttachmentError(t('chat.attachmentTooLarge'));
			return;
		}
		const buffer = await file.arrayBuffer();
		const base64 = toBase64(buffer);
		const meta   = await window.electronAPI.saveAttachment(chatId, file.name, file.type || undefined, base64);
		setPendingAttachments((prev) => [...prev, meta]);

		// Preload previews for images
		if (meta.mimeType.startsWith('image/')) {
			const dataUrl = await window.electronAPI.getAttachmentDataUrl(meta.storedPath, meta.mimeType);
			setAttachmentPreviewMap((prev) => {
				const next = new Map(prev);
				next.set(meta.storedPath, dataUrl);
				return next;
			});
		}
	}

	async function handleFileInputChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
		const files = event.target.files ? Array.from(event.target.files) : [];
		for (const f of files) {
			// eslint-disable-next-line no-await-in-loop
			await addFileAsAttachment(f);
		}
		// reset input so selecting the same file again still triggers change
		event.target.value = '';
	}

	function removePendingAttachment(id: string): void {
		setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
	}

	async function handleSend(): Promise<void> {
		if ((!inputValue.trim() && pendingAttachments.length === 0) || isSending || isStreamRunning) {
			return;
		}

		if (clarificationRequest) {
			const messageText                   = inputValue;
			const clarificationMessage: Message = {
				role       : 'user',
				content    : messageText,
				timestamp  : new Date(),
				attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
			};
			setMessages((prev) => [...prev, clarificationMessage]);
			setInputValue('');
			clearDraft(chatId);
			setPendingAttachments([]);
			await submitClarification(chatId, messageText, pendingAttachments);
			return;
		}

		const messageText          = inputValue;
		const userMessage: Message = {
			role       : 'user',
			content    : messageText,
			timestamp  : new Date(),
			attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
		};

		const newMessages = [...messages, userMessage];
		stickToBottomReference.current = true;
		setMessages(newMessages);
		setInputValue('');
		clearDraft(chatId);
		setPendingAttachments([]);
		setIsSending(true);

		try {
			// Prior turns only - the message being sent is passed separately. Assistant turns use
			// detailedContent (answer + queries/files it looked at) so follow-ups keep that context.
			const conversationHistory = messages.slice(-40).map((m) => ({
				role   : m.role,
				content: m.role === 'assistant' && m.detailedContent ? m.detailedContent : m.content,
			}));

			const effectiveDatabaseName = databaseName.trim() || undefined;
			const effectiveDbHost       = selectedChat?.dbHost && selectedChat.dbHost.trim() !== ''
				? selectedChat.dbHost.trim()
				: (filterDev ? DEV_SQL_HOST : undefined);
			// Without a branch on the chat the main process uses the repository's default branch.
			const effectiveGithubBranch = selectedChat?.branch?.trim() || undefined;

			// If connection + database are provided, enable database tools.
			const databaseIds = connection && effectiveDatabaseName ? [connection.id] : [];
			await startChatStream({
				chatId,
				message    : messageText,
				databases  : databaseIds,
				history    : conversationHistory,
				chatContext: {
					databaseName: effectiveDatabaseName,
					dbHost      : effectiveDbHost,
					githubBranch: effectiveGithubBranch,
				},
				attachments: pendingAttachments,
			});
			onChatUpdate();
		} catch (error) {
			const errorMessage: Message = {
				role     : 'assistant',
				content  : `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
				timestamp: new Date(),
			};

			const finalMessages = [...newMessages, errorMessage];
			setMessages(finalMessages);
			await saveMessages(finalMessages);
		} finally {
			setIsSending(false);
		}
	}

	function handleStop(): void {
		if (!isStreamRunning) {
			return;
		}
		void stopChatStream(chatId);
	}

	function toggleExpanded(messageIndex: number): void {
		setExpandedMessageMap((previous) => {
			const next     = new Map(previous);
			const existing = next.get(messageIndex) || false;
			next.set(messageIndex, !existing);
			return next;
		});
	}

	async function chooseSystemMode(mode: 'active' | 'restore' | 'dev'): Promise<void> {
		if (mode === 'dev') {
			if (!filterDev) {
				await toggleDevMode(true);
			}
			return;
		}
		if (filterDev) {
			await toggleDevMode(false);
		}
		setSystemFilterMode(mode);
	}

	function openSystemSearch(): void {
		setSystemSearch('');
		setHighlightedSystem(0);
		setShowSystemResults(true);
	}

	function focusSystemSearch(): void {
		systemInputReference.current?.focus();
	}

	function handleSystemSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
		if (filterDev) {
			if (event.key === 'Enter') {
				event.currentTarget.blur();
			}
			return;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			setShowSystemResults(true);
			const step = event.key === 'ArrowDown' ? 1 : -1;
			setHighlightedSystem((current) => Math.min(Math.max(current + step, 0), Math.max(filteredSystems.length - 1, 0)));
		} else if (event.key === 'Enter' && showSystemResults && filteredSystems[highlightedSystem]) {
			event.preventDefault();
			void selectSystem(filteredSystems[highlightedSystem]);
			event.currentTarget.blur();
		} else if (event.key === 'Escape') {
			setShowSystemResults(false);
			event.currentTarget.blur();
		}
	}

	async function copyMessage(index: number, text: string): Promise<void> {
		await navigator.clipboard.writeText(text);
		setCopiedIndex(index);
		setTimeout(() => setCopiedIndex((current) => (current === index ? null : current)), 1500);
	}

	function applyExamplePrompt(prompt: string): void {
		setInputValue(prompt);
		textareaReference.current?.focus();
	}

	function handleMessagesScroll(event: React.UIEvent<HTMLDivElement>): void {
		const element                  = event.currentTarget;
		stickToBottomReference.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
	}

	function handleDragOver(event: React.DragEvent<HTMLDivElement>): void {
		if (!event.dataTransfer.types.includes('Files')) {
			return;
		}
		event.preventDefault();
		setIsDragging(true);
	}

	function handleDragLeave(event: React.DragEvent<HTMLDivElement>): void {
		if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
			return;
		}
		setIsDragging(false);
	}

	async function handleDrop(event: React.DragEvent<HTMLDivElement>): Promise<void> {
		event.preventDefault();
		setIsDragging(false);
		for (const file of Array.from(event.dataTransfer.files)) {
			// eslint-disable-next-line no-await-in-loop
			await addFileAsAttachment(file);
		}
		textareaReference.current?.focus();
	}

	const isBusy            = isSending || isStreamRunning;
	const showLoadingBubble = isSending || (isStreamRunning && !(streamState?.hasStreamedContent));
	const hasSystem         = databaseName.trim() !== '';
	const serverHost        = hasSystem ? (selectedChat?.dbHost || connection?.host || '') : '';

	const displayedMessages = useMemo(() => {
		const base = [...messages];
		if (isStreamRunning && streamState?.hasStreamedContent) {
			base.push(buildStreamAssistantMessage(streamState));
		}
		if (streamState?.status === 'error' && streamState.error) {
			base.push({
				role     : 'assistant',
				content  : `Error: ${streamState.error}`,
				timestamp: new Date(),
			});
		}
		return base;
	}, [messages, isStreamRunning, streamState?.hasStreamedContent, streamState?.partialText, streamState?.status, streamState?.error]);

	if (!hasApiKey) {
		return (
			<div className="chat-view">
				<div className="setup-required">
					<span className="brand-mark large">J</span>
					<h2>{t('chat.setupTitle')}</h2>
					<p>{t('chat.setupText')}</p>
				</div>
			</div>
		);
	}

	if (!isInitialized) {
		return (
			<div className="chat-view">
				<div className="setup-required">
					<div className="spinner"/>
				</div>
			</div>
		);
	}

	return (
		<div
			className={`chat-view ${isDragging ? 'dragging' : ''}`}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			<header className="chat-header">
				<div className="chat-title" title={selectedChat?.title}>{chatTitle(selectedChat?.title)}</div>

				<div className="chat-context">
					<div className="system-picker" ref={systemSelectorReference}>
						<label className={`system-search ${hasSystem ? '' : 'empty'}`} title={t('chat.systemTooltip')}>
							<Icon name={filterDev ? 'database' : 'search'} size={14}/>
							{filterDev ? (
								<input
									ref={systemInputReference}
									type="text"
									value={databaseName}
									onChange={(event) => setDatabaseName(event.target.value)}
									onBlur={saveDevDatabaseNameOnly}
									onKeyDown={handleSystemSearchKeyDown}
									placeholder={t('chat.devDatabase', {host: getServerDisplayName(DEV_SQL_HOST)})}
								/>
							) : (
								<input
									ref={systemInputReference}
									type="text"
									value={showSystemResults ? systemSearch : (selectedChat?.systemName ?? '')}
									onChange={(event) => {
										setSystemSearch(event.target.value);
										setHighlightedSystem(0);
										setShowSystemResults(true);
									}}
									onFocus={openSystemSearch}
								// Also reopen on click when the field is still focused, e.g. after Escape.
								onClick={() => !showSystemResults && openSystemSearch()}
									onKeyDown={handleSystemSearchKeyDown}
									placeholder={showSystemResults && selectedChat?.systemName ? selectedChat.systemName : t('chat.searchSystem')}
								/>
							)}
						</label>

						<div className="segmented" role="radiogroup" aria-label={t('chat.systemType')}>
							{(['active', 'restore', 'dev'] as const).map((mode) => {
								const isActive = mode === 'dev' ? filterDev : (!filterDev && (mode === 'active' ? filterActive : filterRestore));
								return (
									<button
										key={mode}
										type="button"
										role="radio"
										aria-checked={isActive}
										className={isActive ? 'active' : ''}
										onClick={async () => {
											await chooseSystemMode(mode);
											// Dev swaps the input element, so focus after the next render.
											requestAnimationFrame(focusSystemSearch);
										}}
									>
										{t(mode === 'active' ? 'chat.modeActive' : mode === 'restore' ? 'chat.modeRestore' : 'chat.modeDev')}
									</button>
								);
							})}
						</div>

						{!filterDev && showSystemResults && (
							<div className="system-results">
								{systemsLoading && (
									<div className="system-results-row">{t('chat.loadingSystems')}</div>
								)}
								{systemsError && (
									<div className="system-results-row system-results-error">{systemsError}</div>
								)}
								{!systemsLoading && !systemsError && filteredSystems.length === 0 && (
									<div className="system-results-row">{t('chat.noSystems')}</div>
								)}
								{filteredSystems.map((s, index) => (
									<button
										type="button"
										key={s.systemKey}
										className={[
											'system-result-item',
											selectedChat?.systemKey === s.systemKey ? 'selected' : '',
											index === highlightedSystem ? 'highlighted' : '',
										].join(' ')}
										ref={(element) => {
											if (index === highlightedSystem) {
												element?.scrollIntoView({block: 'nearest'});
											}
										}}
										onMouseEnter={() => setHighlightedSystem(index)}
										onMouseDown={(e) => {
											// Select on mousedown so blur/click timing never cancels selection.
											e.preventDefault();
											e.stopPropagation();
											void selectSystem(s);
											systemInputReference.current?.blur();
										}}
										onClick={(e) => e.preventDefault()}
										title={`${s.systemKey} • ${s.databaseName} • ${s.serverHost} • ${s.release ?? ''}`}
									>
										<div className="system-result-main">
											<div className="system-result-name">{s.name}</div>
											<div className="system-result-meta">{s.databaseName} · {getServerDisplayName(s.serverHost)}</div>
										</div>
										{s.release && <div className="system-result-release">{s.release}</div>}
									</button>
								))}
							</div>
						)}
					</div>

					{selectedChat?.branch && selectedChat.branch.trim() !== '' && (
						<span className="context-chip" title={t('chat.branchTooltip')}>
							<Icon name="gitBranch" size={13}/>
							{selectedChat.branch}
						</span>
					)}
					{serverHost && (
						<span className="context-chip" title={t('chat.serverTooltip', {host: serverHost})}>
							<Icon name="server" size={13}/>
							{getServerDisplayName(serverHost)}
						</span>
					)}
					{selectedChat?.systemUrl && (
						<button
							type="button"
							className="icon-btn"
							onClick={async () => {
								if (selectedChat.systemUrl) {
									await window.electronAPI.openExternalUrl(selectedChat.systemUrl);
								}
							}}
							title={t('chat.openSystem', {url: selectedChat.systemUrl})}
						>
							<Icon name="externalLink" size={15}/>
						</button>
					)}
				</div>
			</header>

			<div className="messages" onScroll={handleMessagesScroll}>
				<div className="messages-inner">
					{messages.length === 0 && !isBusy && (
						<div className="welcome">
							<span className="brand-mark large">J</span>
							<h2>{t('chat.welcomeTitle')}</h2>
							{hasSystem ? (
								<p>
									{t('chat.welcomeSystem').split('{system}').map((part, index) => (
										<Fragment key={index}>
											{index > 0 && <strong>{filterDev ? databaseName : selectedChat?.systemName}</strong>}
											{part}
										</Fragment>
									))}
								</p>
							) : (
								<>
									<p>
										{filterDev
											? t('chat.welcomeDevDatabase', {host: DEV_SQL_HOST})
											: t('chat.welcomePickSystem')}
									</p>
									<button className="btn btn-primary" onClick={focusSystemSearch}>
										<Icon name={filterDev ? 'database' : 'search'}/>
										{filterDev ? t('chat.enterDatabase') : t('chat.findSystem')}
									</button>
								</>
							)}
							<div className="example-prompts">
								{EXAMPLE_PROMPTS.map((example) => (
									<button key={example.text} className="example-prompt" onClick={() => applyExamplePrompt(t(example.text))}>
										<Icon name={example.icon} size={16}/>
										<span>{t(example.text)}</span>
									</button>
								))}
							</div>
						</div>
					)}

					{displayedMessages.map((message, index) => {
						const detailedText = message.role === 'assistant' ? (message.detailedContent || '').trim() : '';
						const hasDetailed  = detailedText !== '';
						const isExpanded   = expandedMessageMap.get(index) || false;
						const shownText    = (hasDetailed && isExpanded) ? detailedText : message.content;
						const isStreaming  = isStreamRunning && index === messages.length;

						const attachments = message.attachments && message.attachments.length > 0 && (
							<div className="message-attachments">
								{message.attachments.map((att) => {
									const isImage = att.mimeType.startsWith('image/');
									const preview = isImage ? attachmentPreviewMap.get(att.storedPath) : undefined;
									return (
										<button
											key={att.id}
											type="button"
											className="message-attachment"
											onClick={async () => await window.electronAPI.openAttachment(att.storedPath)}
											title={t('chat.openAttachment')}
										>
											{isImage && preview
												? <img src={preview} alt={att.originalName} className="attachment-image"/>
												: <span className="attachment-icon"><Icon name="file"/></span>}
											<span className="attachment-meta">
												<span className="attachment-name">{att.originalName}</span>
												<span className="attachment-size">{Math.max(1, Math.round(att.sizeBytes / 1024))} KB</span>
											</span>
										</button>
									);
								})}
							</div>
						);

						if (message.role === 'user') {
							return (
								<div key={index} className="message user">
									{attachments}
									{message.content && <div className="message-bubble">{message.content}</div>}
									<div className="message-meta">{userName || t('chat.you')} · {formatTime(message.timestamp, locale)}</div>
								</div>
							);
						}

						return (
							<div key={index} className="message assistant">
								<div className="message-header">
									<span className="brand-mark small">J</span>
									<strong>Jørgen</strong>
									<span className="timestamp">{formatTime(message.timestamp, locale)}</span>
								</div>
								<div className="message-content markdown">
									{attachments}
									<ReactMarkdown
										remarkPlugins={[remarkGfm]}
										rehypePlugins={[rehypeHighlight]}
										components={{
											pre: MarkdownPre,
											a  : ({node: _node, ...props}) => <a {...props} target="_blank" rel="noreferrer"/>,
										}}
									>
										{shownText}
									</ReactMarkdown>
								</div>
								{!isStreaming && (
									<div className="message-actions">
										<button
											className="message-action"
											onClick={() => void copyMessage(index, shownText)}
											title={t('chat.copyTooltip')}
										>
											<Icon name={copiedIndex === index ? 'check' : 'copy'} size={14}/>
											{copiedIndex === index ? t('chat.copied') : t('chat.copy')}
										</button>
										{hasDetailed && (
											<button
												className={`message-action ${isExpanded ? 'active' : ''}`}
												onClick={() => toggleExpanded(index)}
												title={t('chat.detailsTooltip')}
											>
												<Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={14}/>
												{isExpanded ? t('chat.hideDetails') : t('chat.showDetails')}
											</button>
										)}
									</div>
								)}
							</div>
						);
					})}

					{showLoadingBubble && (
						<div className="message assistant">
							<div className="message-header">
								<span className="brand-mark small">J</span>
								<strong>Jørgen</strong>
							</div>
							<div className="thinking">
								<span className="thinking-pulse"/>
								<span className="thinking-text">{translateProgress(progressStatus) || t('chat.thinking')}</span>
								<ElapsedTime since={streamState?.startedAtMs}/>
							</div>
						</div>
					)}

					<div ref={messagesEndReference}/>
				</div>
			</div>

			<div className="composer-wrap">
				{clarificationRequest && (
					<div className="clarification-card">
						<div className="clarification-label">{t('chat.clarificationLabel')}</div>
						<div className="clarification-question">{clarificationRequest.question}</div>
						{clarificationRequest.options && clarificationRequest.options.length > 0 && (
							<div className="clarification-options">
								{clarificationRequest.options.map((opt) => (
									<button
										key={opt}
										className="clarification-option"
										onClick={() => {
											submitClarification(chatId, opt);
										}}
									>
										{opt}
									</button>
								))}
							</div>
						)}
					</div>
				)}

				<div className={`composer ${isDragging ? 'dragging' : ''}`}>
					<input
						ref={fileInputReference}
						type="file"
						style={{display: 'none'}}
						multiple
						onChange={handleFileInputChange}
					/>
					{pendingAttachments.length > 0 && (
						<div className="pending-attachments">
							{pendingAttachments.map((att) => (
								<span key={att.id} className="pending-attachment">
									<Icon name="file" size={13}/>
									<span className="pending-attachment-name">{att.originalName}</span>
									<button
										className="pending-attachment-remove"
										onClick={() => removePendingAttachment(att.id)}
										title={t('chat.removeAttachment')}
									>
										<Icon name="x" size={12}/>
									</button>
								</span>
							))}
						</div>
					)}
					{attachmentError && (
						<div className="attachment-error">
							<Icon name="alert" size={14}/>
							{attachmentError}
						</div>
					)}
					<textarea
						ref={textareaReference}
						value={inputValue}
						onChange={(event) => setInputValue(event.target.value)}
						onPaste={async (event) => {
							const items     = Array.from(event.clipboardData.items);
							const imageItem = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
							if (imageItem) {
								const file = imageItem.getAsFile();
								if (file) {
									event.preventDefault();
									await addFileAsAttachment(file);
								}
							}
						}}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && !event.shiftKey) {
								event.preventDefault();
								handleSend();
							}
						}}
						placeholder={clarificationRequest
							? t('chat.placeholderAnswer')
							: (hasSystem ? t('chat.placeholderSystem', {system: (filterDev ? databaseName : selectedChat?.systemName) ?? ''}) : t('chat.placeholder'))}
						rows={1}
						autoFocus
					/>
					<div className="composer-toolbar">
						<button
							type="button"
							className="icon-btn"
							onClick={() => fileInputReference.current?.click()}
							disabled={isBusy}
							title={t('chat.attachTooltip')}
						>
							<Icon name="paperclip"/>
						</button>
						<span className="composer-mode" title={t('chat.qualityTooltip')}>
							{aiQualityProfile === 'maximum_accuracy' ? t('settings.ai.max') : t('settings.ai.balanced')}
						</span>
						{isStreamRunning ? (
							<button type="button" onClick={handleStop} className="send-button stop" title={t('chat.stop')}>
								<Icon name="stop" size={14}/>
							</button>
						) : (
							<button
								type="button"
								onClick={handleSend}
								className="send-button"
								disabled={isBusy || (!inputValue.trim() && pendingAttachments.length === 0)}
								title={t('chat.send')}
							>
								<Icon name="arrowUp" size={16}/>
							</button>
						)}
					</div>
				</div>
				<div className="composer-footnote">
					{t('chat.footnote')}
				</div>
			</div>

			{isDragging && (
				<div className="drop-overlay">
					<Icon name="paperclip" size={22}/>
					{t('chat.dropFiles')}
				</div>
			)}
		</div>
	);
}

const EXAMPLE_PROMPTS: Array<{ icon: IconName; text: TranslationKey }> = [
	{icon: 'package', text: 'chat.example1'},
	{icon: 'database', text: 'chat.example2'},
	{icon: 'bug', text: 'chat.example3'},
	{icon: 'list', text: 'chat.example4'},
];

function formatTime(date: Date, locale: string): string {
	return date.toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'});
}

function ElapsedTime({since}: { since?: number }): JSX.Element | null {
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);

	if (!since) {
		return null;
	}
	const seconds = Math.max(0, Math.floor((now - since) / 1000));
	return (
		<span className="thinking-elapsed">
			{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
		</span>
	);
}
