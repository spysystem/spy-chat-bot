import {useState, useEffect, useRef, JSX} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type {Message, DatabaseConfig} from '../types';
import type {Chat} from '../types';
import './ChatView.css';
import 'highlight.js/styles/github-dark.css';

interface ChatViewProps {
	chatId: string;
	onChatUpdate: () => void;
}

export function ChatView({chatId, onChatUpdate}: ChatViewProps): JSX.Element {
	const [messages, setMessages]             = useState<Message[]>([]);
	const [inputValue, setInputValue]         = useState('');
	const [isLoading, setIsLoading]           = useState(false);
	const [connection, setConnection]         = useState<DatabaseConfig | null>(null);
	const [databaseName, setDatabaseName]     = useState<string>('');
	const [hasApiKey, setHasApiKey]           = useState(false);
	const [userName, setUserName]             = useState<string>('You');
	const [progressStatus, setProgressStatus] = useState<string>('');
	const [isInitialized, setIsInitialized]   = useState(false);
	const [tldrMap, setTldrMap]               = useState<Map<number, { text: string; isShowing: boolean; isLoading: boolean }>>(new Map());
	const [autoTldr, setAutoTldr]             = useState(false);
	const [selectedChat, setSelectedChat]     = useState<Chat | null>(null);
	const [githubBranch, setGithubBranch]     = useState<string>('');
	const messagesEndReference                = useRef<HTMLDivElement>(null);
	const previousChatIdReference             = useRef<string>(chatId);
	const textareaReference                   = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		async function initialize() {
			setIsInitialized(false);
			await loadConnection();
			await checkApiKey();
			await loadUserName();
			await loadAutoTldr();
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

				// Set the database name for this chat
				if (chat.databaseName) {
					setDatabaseName(chat.databaseName);
				} else {
					setDatabaseName('');
				}
			} else {
				setMessages([]);
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
			role     : m.role,
			content  : m.content,
			timestamp: m.timestamp.toISOString(),
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

	async function loadAutoTldr(): Promise<void> {
		const enabled = await window.electronAPI.getAutoTldr();
		setAutoTldr(enabled);
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
			role     : m.role,
			content  : m.content,
			timestamp: m.timestamp.toISOString(),
		}));

		await window.electronAPI.updateChat(chatId, messagesToSave, undefined, databaseName, selectedChat?.branch);
		onChatUpdate();
	}

	async function handleSend(): Promise<void> {
		if (!inputValue.trim() || isLoading) {
			return;
		}

		const userMessage: Message = {
			role     : 'user',
			content  : inputValue,
			timestamp: new Date(),
		};

		const newMessages = [...messages, userMessage];
		setMessages(newMessages);
		setInputValue('');
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
				inputValue,
				databaseIds,
				conversationHistory,
				dbName,
			);

			setProgressStatus('');

			const assistantMessage: Message = {
				role     : 'assistant',
				content  : response,
				timestamp: new Date(),
			};

			const finalMessages = [...newMessages, assistantMessage];
			setMessages(finalMessages);
			await saveMessages(finalMessages);

			// If auto TL;DR is enabled, generate it automatically for the new message
			if (autoTldr) {
				const messageIndex = finalMessages.length - 1;
				generateTldr(messageIndex, response);
			}
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

	async function generateTldr(messageIndex: number, messageContent: string): Promise<void> {
		// Update loading state
		setTldrMap((previous) => {
			const newMap   = new Map(previous);
			const existing = newMap.get(messageIndex);
			newMap.set(messageIndex, {
				text     : existing?.text || '',
				isShowing: true,
				isLoading: true,
			});
			return newMap;
		});

		try {
			const tldrText = await window.electronAPI.generateTldr(messageContent);

			setTldrMap((previous) => {
				const newMap = new Map(previous);
				newMap.set(messageIndex, {
					text     : tldrText,
					isShowing: true,
					isLoading: false,
				});
				return newMap;
			});
		} catch (error) {
			console.error('Error generating TL;DR:', error);
			setTldrMap((previous) => {
				const newMap = new Map(previous);
				newMap.delete(messageIndex);
				return newMap;
			});
		}
	}

	function toggleTldr(messageIndex: number): void {
		setTldrMap((previous) => {
			const newMap   = new Map(previous);
			const existing = newMap.get(messageIndex);
			if (existing) {
				newMap.set(messageIndex, {
					...existing,
					isShowing: !existing.isShowing,
				});
			}
			return newMap;
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
					const tldrInfo    = tldrMap.get(index);
					const showingTldr = tldrInfo?.isShowing && tldrInfo?.text;

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
								{message.role === 'assistant' && (
									<div className="message-actions">
										{tldrInfo?.text ? (
											<button
												className="tldr-button"
												onClick={() => toggleTldr(index)}
												title={showingTldr ? 'Show full answer' : 'Show TL;DR'}
											>
												{showingTldr ? '📄 Full' : '⚡ TL;DR'}
											</button>
										) : (
											<button
												className="tldr-button"
												onClick={() => generateTldr(index, message.content)}
												disabled={tldrInfo?.isLoading}
												title="Generate short summary"
											>
												{tldrInfo?.isLoading ? '⏳' : '⚡ TL;DR'}
											</button>
										)}
									</div>
								)}
							</div>
							<div className="message-content">
								{message.role === 'assistant' ? (
									<ReactMarkdown
										remarkPlugins={[remarkGfm]}
										rehypePlugins={[rehypeHighlight]}
									>
										{showingTldr ? tldrInfo.text : message.content}
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
				<textarea
					ref={textareaReference}
					value={inputValue}
					onChange={(event) => setInputValue(event.target.value)}
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
				<button onClick={handleSend} disabled={isLoading || !inputValue.trim()}>
					Send
				</button>
			</div>
		</div>
	);
}
