import {useState, useEffect, useMemo, useRef, JSX} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type {AttachmentMeta, Message, DatabaseConfig, SystemDirectorySystem, ChatUpdate} from '../types';
import type {Chat} from '../types';
import {buildStreamAssistantMessage, useAiStreams} from '../ai/AiStreamContext';
import './ChatView.css';
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
	const [userName, setUserName]                         = useState<string>('You');
	const [isInitialized, setIsInitialized]               = useState(false);
	const [expandedMessageMap, setExpandedMessageMap]     = useState<Map<number, boolean>>(new Map());
	const [selectedChat, setSelectedChat]                 = useState<Chat | null>(null);
	const [githubBranch, setGithubBranch]                 = useState<string>('');

	// System selector state (per chat)
	const [systems, setSystems]                             = useState<SystemDirectorySystem[]>([]);
	const [systemsLoading, setSystemsLoading]               = useState<boolean>(false);
	const [systemsError, setSystemsError]                   = useState<string>('');
	const [systemSearch, setSystemSearch]                   = useState<string>('');
	const [showSystemResults, setShowSystemResults]         = useState<boolean>(false);
	const [filterActive, setFilterActive]                   = useState<boolean>(true);
	const [filterRestore, setFilterRestore]                 = useState<boolean>(false);
	const [filterDev, setFilterDev]                         = useState<boolean>(false);
	const [clarificationFreeText, setClarificationFreeText] = useState('');

	const systemSelectorReference = useRef<HTMLDivElement>(null);
	const messagesEndReference    = useRef<HTMLDivElement>(null);
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
	const streamState             = getChatStreamState(chatId);
	const clarificationRequest    = getClarificationRequest(chatId);
	const isStreamRunning         = !!streamState && (streamState.status === 'running' || streamState.status === 'stopping');
	const progressStatus          = streamState?.progressStatus || '';

	useEffect(() => {
		if (!clarificationRequest) {
			setClarificationFreeText('');
		}
	}, [clarificationRequest]);

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
			await checkApiKey();
			await loadUserName();
			await loadGithubBranch();
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
				setSystemSearch(chat.systemName ?? '');
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
			// Stream finished (or errored/stopped) - refresh messages from disk.
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

	useEffect(() => {
		messagesEndReference.current?.scrollIntoView({behavior: 'smooth'});
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

	async function checkApiKey(): Promise<void> {
		const apiKey = await window.electronAPI.getApiKey();
		setHasApiKey(!!apiKey);
	}

	async function loadUserName(): Promise<void> {
		const name = await window.electronAPI.getUserName();
		if (name) {
			setUserName(name);
		}
	}

	async function loadGithubBranch(): Promise<void> {
		const config = await window.electronAPI.getGitHubConfig();
		if (config?.branch) {
			setGithubBranch(config.branch);
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

	function releaseToBranch(release: unknown): string | null {
		const value = String(release ?? '').trim();
		if (!value) {
			return null;
		}

		// 202512.1 -> 2025_12_10
		const fullMatch = value.match(/^(\d{4})(\d{2})\.(\d+)$/);
		if (fullMatch) {
			const [, year, month, patchRaw] = fullMatch;
			// If the patch part is a single digit (e.g. "1"), treat it as tens ("10").
			// This matches the SPY git branch naming convention.
			const patchNum   = Number.parseInt(patchRaw, 10);
			const patchValue = Number.isFinite(patchNum)
				? (patchRaw.length === 1 ? patchNum * 10 : patchNum)
				: patchRaw;
			const patch      = String(patchValue).padStart(2, '0');
			return `${year}_${month}_${patch}`;
		}

		// 202512 -> 2025_12
		const shortMatch = value.match(/^(\d{4})(\d{2})$/);
		if (shortMatch) {
			const [, year, month] = shortMatch;
			return `${year}_${month}`;
		}

		return null;
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
		const branch = releaseToBranch(system.release) ?? undefined;
		setSystemSearch(system.name);
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
		setShowSystemResults(false);
		if (next) {
			await saveChatUpdate({
				isDevMode: true,
				dbHost   : DEV_SQL_HOST,
				// Keep branch as-is (dev DB doesn't imply a code branch)
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
			setAttachmentError('Attachment too large (max 10 MB).');
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

		const messageText          = inputValue;
		const userMessage: Message = {
			role       : 'user',
			content    : messageText,
			timestamp  : new Date(),
			attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
		};

		const newMessages = [...messages, userMessage];
		setMessages(newMessages);
		setInputValue('');
		clearDraft(chatId);
		setPendingAttachments([]);
		setIsSending(true);

		try {
			// Build conversation history with technical detail (detailedContent)
			// so Claude remembers which tables/schemas it discovered earlier.
			// Send up to 20 messages but truncate very large assistant answers.
			const MAX_HISTORY_MESSAGES   = 20;
			const MAX_ASSISTANT_CHAR_LEN = 2000;

			const recentMessages      = newMessages.slice(-MAX_HISTORY_MESSAGES);
			const conversationHistory = recentMessages.map((m) => {
				// For assistant messages, prefer detailedContent (contains SQL, tables, schemas)
				// over the simplified user-friendly content.
				let text = (m.role === 'assistant' && m.detailedContent)
					? m.detailedContent
					: m.content;

				// Truncate very large assistant answers to stay within token limits
				// but keep enough to preserve table names, queries, and schema info.
				if (m.role === 'assistant' && text.length > MAX_ASSISTANT_CHAR_LEN) {
					text = text.substring(0, MAX_ASSISTANT_CHAR_LEN) + '\n\n[... truncated for brevity ...]';
				}

				return {
					role   : m.role,
					content: text,
				};
			});

			const effectiveDatabaseName = databaseName.trim() || undefined;
			const effectiveDbHost       = selectedChat?.dbHost && selectedChat.dbHost.trim() !== ''
				? selectedChat.dbHost.trim()
				: (filterDev ? DEV_SQL_HOST : undefined);
			const effectiveGithubBranch = selectedChat?.branch && selectedChat.branch.trim() !== ''
				? selectedChat.branch.trim()
				: undefined;

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

	const isBusy            = isSending || isStreamRunning;
	const showLoadingBubble = isSending || (isStreamRunning && !(streamState?.hasStreamedContent));

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
					<h2>Setup Required</h2>
					<p>Please configure your Claude API key in Settings to start chatting.</p>
				</div>
			</div>
		);
	}

	if (!isInitialized) {
		return (
			<div className="chat-view">
				<div className="setup-required">
					<p>Loading...</p>
				</div>
			</div>
		);
	}

	return (
		<div className="chat-view">
			<div className="chat-title-bar">
				<div className="chat-title">{selectedChat?.title || 'New Chat'}</div>
			</div>
			<div className="badge-container">
				{(selectedChat?.branch || githubBranch) && (
					<div className="branch-badge">
						<span className="branch-icon">🔀</span>
						<span className="branch-name">{selectedChat?.branch || githubBranch}</span>
					</div>
				)}
				{(selectedChat?.dbHost || connection?.host) && (
					<div className="server-badge">
						<span className="server-icon">🖥️</span>
						<span className="server-name">{getServerDisplayName(selectedChat?.dbHost || connection!.host)}</span>
					</div>
				)}
			</div>

			<div className="system-selector" ref={systemSelectorReference}>
				<div className="system-selector-row">
					<label htmlFor="system-search">System:</label>
					<div className="system-search-wrapper">
						<input
							id="system-search"
							type="text"
							value={systemSearch}
							onChange={(event) => {
								setSystemSearch(event.target.value);
								setShowSystemResults(true);
							}}
							onFocus={() => setShowSystemResults(true)}
							className="system-search-input"
							placeholder={filterDev ? 'Dev mode enabled' : 'Search customer/system (name, key, DB, host)'}
							disabled={filterDev}
						/>
						{selectedChat?.systemUrl && (
							<button
								onClick={async () => {
									if (selectedChat.systemUrl) {
										await window.electronAPI.openExternalUrl(selectedChat.systemUrl);
									}
								}}
								className="system-url-link"
								title={`Open system: ${selectedChat.systemUrl}`}
								type="button"
							>
								🌐
							</button>
						)}

						{!filterDev && showSystemResults && (
							<div className="system-results">
								{systemsLoading && (
									<div className="system-results-row">Loading systems…</div>
								)}
								{systemsError && (
									<div className="system-results-row system-results-error">⚠ {systemsError}</div>
								)}
								{!systemsLoading && !systemsError && filteredSystems.length === 0 && (
									<div className="system-results-row">No matches.</div>
								)}
								{filteredSystems.map((s) => (
									<button
										type="button"
										key={s.systemKey}
										className="system-result-item"
										onMouseDown={(e) => {
											// Select on mousedown so blur/click timing never cancels selection.
											e.preventDefault();
											e.stopPropagation();
											void selectSystem(s);
										}}
										onClick={(e) => e.preventDefault()}
										title={`${s.systemKey} • ${s.databaseName} • ${s.serverHost} • ${s.release ?? ''}`}
									>
										<div className="system-result-main">
											<div className="system-result-name">{s.name}</div>
											<div className="system-result-meta">{s.databaseName} @ {getServerDisplayName(s.serverHost)}</div>
										</div>
										<div className="system-result-release">{s.release ?? ''}</div>
									</button>
								))}
							</div>
						)}
					</div>

					<div className="system-filters">
						<label className={`system-checkbox ${filterActive ? 'checked' : ''}`}>
							<input
								type="checkbox"
								checked={filterActive}
								onChange={(e) => {
									if (e.target.checked) {
										setSystemFilterMode('active');
									}
								}}
								disabled={filterDev}
							/>
							<span>Active</span>
						</label>
						<label className={`system-checkbox ${filterRestore ? 'checked' : ''}`}>
							<input
								type="checkbox"
								checked={filterRestore}
								onChange={(e) => {
									if (e.target.checked) {
										setSystemFilterMode('restore');
									}
								}}
								disabled={filterDev}
							/>
							<span>Restore</span>
						</label>
						<label className={`system-checkbox ${filterDev ? 'checked' : ''}`}>
							<input
								type="checkbox"
								checked={filterDev}
								onChange={(e) => void toggleDevMode(e.target.checked)}
							/>
							<span>Dev</span>
						</label>
					</div>
				</div>

				{filterDev && (
					<div className="system-selector-row">
						<label htmlFor="dev-database-name">Database:</label>
						<input
							id="dev-database-name"
							type="text"
							value={databaseName}
							onChange={(event) => setDatabaseName(event.target.value)}
							onBlur={saveDevDatabaseNameOnly}
							className="system-search-input"
							placeholder="Enter database name"
						/>
						<div className="system-dev-host">
							Host: <span className="system-dev-host-value">{DEV_SQL_HOST}</span>
						</div>
					</div>
				)}

			</div>

			<div className="messages">
				{messages.length === 0 && (
					<div className="welcome">
						<h2>Welcome to Spørge Jørgen</h2>
						<p>Ask any question, Jørgen can help you!</p>
					</div>
				)}

				{displayedMessages.map((message, index) => {
					const hasDetailed = message.role === 'assistant' && !!message.detailedContent && message.detailedContent.trim() !== '' && message.detailedContent.trim() !== message.content.trim();
					const isExpanded  = expandedMessageMap.get(index) || false;
					const shownText   = (hasDetailed && isExpanded) ? (message.detailedContent as string) : message.content;

					return (
						<div key={index} className={`message ${message.role}`}>
							<div className="message-header">
								<div className="message-avatar">
									{message.role === 'user' ? '👤' : '🤖'}
								</div>
								<div className="message-info">
									<strong>{message.role === 'user' ? userName : 'Jørgen'}</strong>
									<span className="timestamp">
										{message.timestamp.toLocaleTimeString()}
									</span>
								</div>
								{hasDetailed && (
									<div className="message-actions">
										<button
											className="details-button"
											onClick={() => toggleExpanded(index)}
											title={isExpanded ? 'Show a short answer' : 'Show a detailed answer'}
										>
											{isExpanded ? 'Short' : 'Details'}
										</button>
									</div>
								)}
							</div>
							<div className="message-content">
								{message.attachments && message.attachments.length > 0 && (
									<div className="message-attachments">
										{message.attachments.map((att) => {
											const isImage = att.mimeType.startsWith('image/');
											const preview = isImage ? attachmentPreviewMap.get(att.storedPath) : undefined;
											return (
												<div key={att.id} className="message-attachment">
													{isImage && preview && (
														<img
															src={preview}
															alt={att.originalName}
															className="attachment-image"
															onClick={async () => await window.electronAPI.openAttachment(att.storedPath)}
														/>
													)}
													<div className="attachment-meta">
														<div className="attachment-name">{att.originalName}</div>
														<div className="attachment-size">{Math.round(att.sizeBytes / 1024)} KB</div>
													</div>
													<button
														className="attachment-open"
														onClick={async () => await window.electronAPI.openAttachment(att.storedPath)}
													>
														Open
													</button>
												</div>
											);
										})}
									</div>
								)}
								{message.role === 'assistant' ? (
									<ReactMarkdown
										remarkPlugins={[remarkGfm]}
										rehypePlugins={[rehypeHighlight]}
									>
										{shownText}
									</ReactMarkdown>
								) : (
									<div className="user-text">{message.content}</div>
								)}
							</div>
						</div>
					);
				})}

				{showLoadingBubble && (
					<div className="message assistant">
						<div className="message-header">
							<div className="message-avatar">🤖</div>
							<div className="message-info">
								<strong>Jørgen</strong>
							</div>
						</div>
						<div className="message-content loading">
							<div className="loading-dots">
								<span></span>
								<span></span>
								<span></span>
							</div>
							<div className="progress-status">
								{progressStatus || 'Thinking...'}
							</div>
						</div>
					</div>
				)}

				<div ref={messagesEndReference}/>
			</div>

			{clarificationRequest && (
				<div className="clarification-area">
					<div className="clarification-question">{clarificationRequest.question}</div>
					{clarificationRequest.options && clarificationRequest.options.length > 0 && (
						<div className="clarification-options">
							{clarificationRequest.options.map((opt) => (
								<button
									key={opt}
									className="clarification-option"
									onClick={() => {
										setClarificationFreeText('');
										submitClarification(chatId, opt);
									}}
								>
									{opt}
								</button>
							))}
						</div>
					)}
					{(clarificationRequest.allowFreeText || (clarificationRequest.options?.length ?? 0) === 0) && (
						<div className="clarification-free-text">
							<input
								type="text"
								value={clarificationFreeText}
								onChange={(e) => setClarificationFreeText(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										const text = clarificationFreeText.trim();
										if (text) {
											setClarificationFreeText('');
											submitClarification(chatId, text);
										}
									}
								}}
								placeholder="Type your answer..."
								autoFocus
							/>
							<button
								onClick={() => {
									const text = clarificationFreeText.trim();
									if (text) {
										setClarificationFreeText('');
										submitClarification(chatId, text);
									}
								}}
								disabled={!clarificationFreeText.trim()}
							>
								Send
							</button>
						</div>
					)}
				</div>
			)}

			<div className="input-area">
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
							<div key={att.id} className="pending-attachment">
								<span className="pending-attachment-name">{att.originalName}</span>
								<button className="pending-attachment-remove" onClick={() => removePendingAttachment(att.id)}>
									Remove
								</button>
							</div>
						))}
					</div>
				)}
				{attachmentError && (
					<div className="attachment-error">{attachmentError}</div>
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
					placeholder="Ask away!"
					disabled={isBusy || !!clarificationRequest}
					autoFocus
				/>
				<button
					onClick={() => fileInputReference.current?.click()}
					disabled={isBusy || !!clarificationRequest}
					className="attach-button"
				>
					Attach
				</button>
				{isStreamRunning && (
					<button onClick={handleStop} className="stop-button">
						Stop
					</button>
				)}
				<button onClick={handleSend} disabled={isBusy || !!clarificationRequest || (!inputValue.trim() && pendingAttachments.length === 0)}>
					Send
				</button>
			</div>
		</div>
	);
}
