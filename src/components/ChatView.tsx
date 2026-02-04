import {useState, useEffect, useRef, JSX} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type {AttachmentMeta, Message, DatabaseConfig} from '../types';
import type {Chat} from '../types';
import './ChatView.css';
import 'highlight.js/styles/github-dark.css';

interface ChatViewProps {
	chatId: string;
	onChatUpdate: () => void;
}

export function ChatView({chatId, onChatUpdate}: ChatViewProps): JSX.Element {
	const [messages, setMessages]                         = useState<Message[]>([]);
	const [inputValue, setInputValue]                     = useState('');
	const [isLoading, setIsLoading]                       = useState(false);
	const [connection, setConnection]                     = useState<DatabaseConfig | null>(null);
	const [databaseName, setDatabaseName]                 = useState<string>('');
	const [pendingAttachments, setPendingAttachments]     = useState<AttachmentMeta[]>([]);
	const [attachmentPreviewMap, setAttachmentPreviewMap] = useState<Map<string, string>>(new Map()); // storedPath -> dataUrl
	const [attachmentError, setAttachmentError]           = useState<string>('');
	const [hasApiKey, setHasApiKey]                       = useState(false);
	const [userName, setUserName]                         = useState<string>('You');
	const [progressStatus, setProgressStatus]             = useState<string>('');
	const [isInitialized, setIsInitialized]               = useState(false);
	const [expandedMessageMap, setExpandedMessageMap]     = useState<Map<number, boolean>>(new Map());
	const [selectedChat, setSelectedChat]                 = useState<Chat | null>(null);
	const [githubBranch, setGithubBranch]                 = useState<string>('');
	const messagesEndReference                            = useRef<HTMLDivElement>(null);
	const previousChatIdReference                         = useRef<string>(chatId);
	const textareaReference                               = useRef<HTMLTextAreaElement>(null);
	const fileInputReference                              = useRef<HTMLInputElement>(null);

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

		// Setup progress listener
		const unsubscribe = window.electronAPI.onMessageProgress((status) => {
			setProgressStatus(status);
		});

		return () => {
			unsubscribe();
		};
	}, [chatId]);

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
				if (chat.databaseName) {
					setDatabaseName(chat.databaseName);
				} else {
					setDatabaseName('');
				}
			} else {
				setMessages([]);
				setExpandedMessageMap(new Map());
				setDatabaseName('');
			}
		}

		loadChatData();
		previousChatIdReference.current = chatId;
	}, [chatId]);

	useEffect(() => {
		messagesEndReference.current?.scrollIntoView({behavior: 'smooth'});
	}, [messages]);

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

	async function saveDatabaseNameOnly(): Promise<void> {
		// Convert current messages to storage format
		const messagesToSave = messages.map((m) => ({
			role           : m.role,
			content        : m.content,
			detailedContent: m.detailedContent,
			timestamp      : m.timestamp.toISOString(),
			attachments    : m.attachments,
		}));

		await window.electronAPI.updateChat(chatId, messagesToSave, undefined, databaseName, selectedChat?.branch);
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

		await window.electronAPI.updateChat(chatId, messagesToSave, undefined, databaseName, selectedChat?.branch);
		onChatUpdate();
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
		if ((!inputValue.trim() && pendingAttachments.length === 0) || isLoading) {
			return;
		}

		const userMessage: Message = {
			role       : 'user',
			content    : inputValue,
			timestamp  : new Date(),
			attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
		};

		const newMessages = [...messages, userMessage];
		setMessages(newMessages);
		setInputValue('');
		setPendingAttachments([]);
		setIsLoading(true);
		setProgressStatus('Preparing...');

		// Save user message immediately
		await saveMessages(newMessages);

		try {
			// Send only the last 5 messages for context to avoid token limit
			// (some queries return very large results)
			const recentMessages      = messages.slice(-5);
			const conversationHistory = recentMessages.map((m) => ({
				role   : m.role,
				content: m.content,
			}));

			// If connection and database name are provided, use them for database queries
			const databaseIds = connection && databaseName.trim() ? [connection.id] : [];
			const dbName      = databaseName.trim() || undefined;

			const response = await window.electronAPI.sendMessage(
				chatId,
				inputValue,
				databaseIds,
				conversationHistory,
				dbName,
				pendingAttachments,
			);

			setProgressStatus('');

			const assistantMessage: Message = {
				role           : 'assistant',
				content        : response.shortAnswer,
				detailedContent: response.detailedAnswer || undefined,
				timestamp      : new Date(),
			};

			const finalMessages = [...newMessages, assistantMessage];
			setMessages(finalMessages);
			await saveMessages(finalMessages);
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
			setIsLoading(false);
			setProgressStatus('');
		}
	}

	function toggleExpanded(messageIndex: number): void {
		setExpandedMessageMap((previous) => {
			const next     = new Map(previous);
			const existing = next.get(messageIndex) || false;
			next.set(messageIndex, !existing);
			return next;
		});
	}

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
			<div className="badge-container">
				{(selectedChat?.branch || githubBranch) && (
					<div className="branch-badge">
						<span className="branch-icon">🔀</span>
						<span className="branch-name">{selectedChat?.branch || githubBranch}</span>
					</div>
				)}
				{connection?.host && (
					<div className="server-badge">
						<span className="server-icon">🖥️</span>
						<span className="server-name">{getServerDisplayName(connection.host)}</span>
					</div>
				)}
			</div>
			{connection && (
				<div className="database-selector">
					<label htmlFor="database-name">Database (optional):</label>
					<input
						id="database-name"
						type="text"
						value={databaseName}
						onChange={(event) => setDatabaseName(event.target.value)}
						onBlur={saveDatabaseNameOnly}
						className="database-input"
						placeholder="Enter database name or leave empty"
					/>
				</div>
			)}

			<div className="messages">
				{messages.length === 0 && (
					<div className="welcome">
						<h2>Welcome to Spørge Jørgen</h2>
						<p>Ask any question, Jørgen can help you!</p>
					</div>
				)}

				{messages.map((message, index) => {
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
									<p>{message.content}</p>
								)}
							</div>
						</div>
					);
				})}

				{isLoading && (
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
					disabled={isLoading}
					autoFocus
				/>
				<button
					onClick={() => fileInputReference.current?.click()}
					disabled={isLoading}
					className="attach-button"
				>
					Attach
				</button>
				<button onClick={handleSend} disabled={isLoading || (!inputValue.trim() && pendingAttachments.length === 0)}>
					Send
				</button>
			</div>
		</div>
	);
}
