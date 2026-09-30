import {useState, useEffect, useMemo, JSX} from 'react';
import {ChatView} from './components/ChatView';
import {SettingsView} from './components/SettingsView';
import {DebugView} from './components/DebugView';
import {ConfirmModal} from './components/ConfirmModal';
import {UpdateModal} from './components/UpdateModal';
import {Icon} from './components/Icon';
import {useTheme} from './ThemeContext';
import {type TranslationKey, useI18n} from './i18n';
import type {Chat} from './types';
import {AiStreamProvider, useAiStreams} from './ai/AiStreamContext';
import './App.css';

type View = 'chat' | 'settings' | 'debug';

/** Filters chats by title/system and buckets them by last activity (chats are already newest first). */
function groupChatsByDate(chats: Chat[], search: string): Array<{ label: TranslationKey; chats: Chat[] }> {
	const needle     = search.trim().toLowerCase();
	const startOfDay = new Date();
	startOfDay.setHours(0, 0, 0, 0);
	const dayMs   = 24 * 60 * 60 * 1000;
	const buckets = [
		{label: 'sidebar.today' as const, from: startOfDay.getTime()},
		{label: 'sidebar.yesterday' as const, from: startOfDay.getTime() - dayMs},
		{label: 'sidebar.previous7' as const, from: startOfDay.getTime() - 7 * dayMs},
		{label: 'sidebar.previous30' as const, from: startOfDay.getTime() - 30 * dayMs},
		{label: 'sidebar.older' as const, from: -Infinity},
	];
	const groups  = buckets.map((bucket) => ({label: bucket.label, chats: [] as Chat[]}));

	for (const chat of chats) {
		if (needle && !`${chat.title} ${chat.systemName ?? ''}`.toLowerCase().includes(needle)) {
			continue;
		}
		const updatedAt = new Date(chat.updatedAt).getTime();
		const index     = buckets.findIndex((bucket) => updatedAt >= bucket.from);
		groups[index].chats.push(chat);
	}

	return groups.filter((group) => group.chats.length > 0);
}

export function App(): JSX.Element {
	const {theme, toggleTheme}              = useTheme();
	// Check if URL hash is #debug to show debug view
	const initialView                       = window.location.hash === '#debug' ? 'debug' : 'chat';

	// Check if electronAPI is available
	if (!window.electronAPI) {
		return (
			<div style={{padding: '40px', textAlign: 'center'}}>
				<h2>Error: Electron API not available</h2>
				<p>The preload script failed to load. Please restart the application.</p>
				<p style={{fontSize: '12px', color: '#888', marginTop: '20px'}}>
					If this persists, check the console for errors.
				</p>
			</div>
		);
	}

	return (
		<AiStreamProvider>
			<AppWithStreams theme={theme} toggleTheme={toggleTheme} initialView={initialView}/>
		</AiStreamProvider>
	);
}

function AppWithStreams(props: { theme: string; toggleTheme: () => void; initialView: View }): JSX.Element {
	const {theme, toggleTheme, initialView}          = props;
	const {isChatRunning}                            = useAiStreams();
	const {t, chatTitle}                             = useI18n();
	const [currentView, setCurrentView]              = useState<View>(initialView);
	const [chats, setChats]                          = useState<Chat[]>([]);
	const [currentChatId, setCurrentChatId]          = useState<string | null>(null);
	const [chatToDelete, setChatToDelete]            = useState<string | null>(null);
	const [showClearAllModal, setShowClearAllModal]  = useState(false);
	const [chatSearch, setChatSearch]                = useState('');
	const [userName, setUserName]                    = useState('');

	// Update modal state
	const [showUpdateModal, setShowUpdateModal]      = useState(false);
	const [updateVersion, setUpdateVersion]          = useState('');
	const [updateDownloading, setUpdateDownloading]  = useState(false);
	const [updateProgress, setUpdateProgress]        = useState(0);
	const [updateReady, setUpdateReady]              = useState(false);
	const [updateError, setUpdateError]              = useState<string | undefined>();
	const [forceUpdate]                              = useState(true);

	useEffect(() => {
		loadChats();

		// Setup deep link listener
		const unsubscribeDeepLink = window.electronAPI.onDeepLink((url) => {
			handleDeepLink(url);
		});

		// Setup update event listeners
		const unsubscribeUpdateAvailable = window.electronAPI.onUpdateAvailable((info) => {
			setUpdateVersion(info.version);
			setShowUpdateModal(true);
		});

		const unsubscribeDownloadProgress = window.electronAPI.onUpdateDownloadProgress((progress) => {
			setUpdateDownloading(true);
			setUpdateProgress(Math.round(progress.percent));
		});

		const unsubscribeUpdateDownloaded = window.electronAPI.onUpdateDownloaded(() => {
			setUpdateDownloading(false);
			setUpdateReady(true);
		});

		const unsubscribeUpdateError = window.electronAPI.onUpdateError((error) => {
			setUpdateError(error);
			setUpdateDownloading(false);
		});

		return () => {
			unsubscribeDeepLink();
			unsubscribeUpdateAvailable();
			unsubscribeDownloadProgress();
			unsubscribeUpdateDownloaded();
			unsubscribeUpdateError();
		};
	}, []);

	// The name can be changed in Settings, so re-read it when returning to the chat.
	useEffect(() => {
		if (currentView !== 'chat') {
			return;
		}
		void window.electronAPI.getUserName().then((name) => setUserName(name ?? ''));
	}, [currentView]);

	const chatGroups = useMemo(() => groupChatsByDate(chats, chatSearch), [chats, chatSearch]);

	async function loadChats(): Promise<void> {
		const allChats = await window.electronAPI.getChats();
		setChats(allChats);

		// If no current chat and there are chats, select the first
		if (!currentChatId && allChats.length > 0) {
			setCurrentChatId(allChats[0].id);
		}
	}

	async function createNewChat(): Promise<void> {
		const newChat = await window.electronAPI.createChat();
		setChats((previous) => [newChat, ...previous]);
		setCurrentView('chat');
		// Set chat ID after a small delay to ensure DOM is ready
		setTimeout(() => {
			setCurrentChatId(newChat.id);
		}, 50);
	}

	async function handleDeepLink(url: string): Promise<void> {
		try {
			// Parse URL: sporge-jorgen://open?database=spy_live&branch=2026_02
			const urlObject = new URL(url);
			const database  = urlObject.searchParams.get('database');
			const branch    = urlObject.searchParams.get('branch');

			if (database) {
				// Create new chat
				const newChat = await window.electronAPI.createChat(`Query: ${database}`);

				// Update chat with database name and branch
				await window.electronAPI.updateChat(newChat.id, [], {
					title       : newChat.title,
					databaseName: database,
					branch      : branch || undefined,
				});

				// Add to chats list and set as current
				setChats((previous) => [newChat, ...previous]);
				setCurrentView('chat');
				setTimeout(() => {
					setCurrentChatId(newChat.id);
				}, 100);
			}
		} catch (error) {
			console.error('Error handling deep link:', error);
		}
	}

	function openDeleteModal(chatId: string): void {
		setChatToDelete(chatId);
	}

	function closeDeleteModal(): void {
		setChatToDelete(null);
	}

	function openClearAllModal(): void {
		setShowClearAllModal(true);
	}

	function closeClearAllModal(): void {
		setShowClearAllModal(false);
	}

	async function confirmDelete(): Promise<void> {
		if (!chatToDelete) {
			return;
		}

		await window.electronAPI.deleteChat(chatToDelete);
		const updatedChats = chats.filter((c) => c.id !== chatToDelete);
		setChats(updatedChats);

		// If we deleted the current chat, switch to another one or set to null
		if (currentChatId === chatToDelete) {
			if (updatedChats.length > 0) {
				// Small delay before switching to new chat
				setTimeout(() => {
					setCurrentChatId(updatedChats[0].id);
				}, 50);
			} else {
				// No more chats - set to null
				setCurrentChatId(null);
			}
		}

		// Close modal and force window focus after deletion
		setChatToDelete(null);
		await window.electronAPI.focusWindow();
	}

	async function confirmClearAllChats(): Promise<void> {
		await window.electronAPI.clearAllChats();
		setChats([]);
		setCurrentChatId(null);
		setShowClearAllModal(false);
		await window.electronAPI.focusWindow();
	}

	function selectChat(chatId: string): void {
		setCurrentChatId(chatId);
		setCurrentView('chat');
	}

	// Update handlers
	async function handleDownloadUpdate(): Promise<void> {
		setUpdateDownloading(true);
		setUpdateProgress(0);
		setUpdateError(undefined);
		try {
			const result = await window.electronAPI.downloadUpdate();
			if (!result.success) {
				setUpdateError(result.error);
				setUpdateDownloading(false);
			}
		} catch (error) {
			setUpdateError(String(error));
			setUpdateDownloading(false);
		}
	}

	function handleInstallUpdate(): void {
		window.electronAPI.installUpdate();
	}

	function handleDismissUpdate(): void {
		if (!forceUpdate) {
			setShowUpdateModal(false);
		}
	}

	return (
		<div className="app">
			{currentView !== 'debug' && (
				<aside className="sidebar">
					<div className="sidebar-brand">
						<span className="brand-mark">J</span>
						<span className="sidebar-brand-name">Spørge Jørgen</span>
					</div>

					<div className="sidebar-actions">
						<button className="btn new-chat-btn" onClick={createNewChat}>
							<Icon name="plus"/>
							{t('sidebar.newChat')}
						</button>
						{chats.length > 0 && (
							<label className="sidebar-search">
								<Icon name="search" size={14}/>
								<input
									type="text"
									value={chatSearch}
									onChange={(event) => setChatSearch(event.target.value)}
									placeholder={t('sidebar.searchChats')}
								/>
							</label>
						)}
					</div>

					<div className="chat-list">
						{chatGroups.map((group) => (
							<div key={group.label} className="chat-group">
								<div className="chat-group-header">{t(group.label)}</div>
								{group.chats.map((chat) => (
									<div
										key={chat.id}
										className={`chat-item ${currentView === 'chat' && currentChatId === chat.id ? 'active' : ''}`}
										onClick={() => selectChat(chat.id)}
									>
										<div className="chat-item-content">
											<div className="chat-item-title">{chatTitle(chat.title)}</div>
											{chat.systemName && (
												<div className="chat-item-meta">{chat.systemName}</div>
											)}
										</div>
										{isChatRunning(chat.id) ? (
											<div className="spinner" title={t('sidebar.working')}/>
										) : (
											<button
												className="icon-btn chat-item-delete"
												onClick={(event) => {
													event.stopPropagation();
													openDeleteModal(chat.id);
												}}
												title={t('sidebar.deleteChat')}
											>
												<Icon name="trash" size={14}/>
											</button>
										)}
									</div>
								))}
							</div>
						))}
						{chats.length > 0 && chatGroups.length === 0 && (
							<div className="chat-list-empty">{t('sidebar.noMatches', {query: chatSearch})}</div>
						)}
						{chats.length > 0 && !chatSearch && (
							<button className="clear-chats-btn" onClick={openClearAllModal}>
								{t('sidebar.clearAll')}
							</button>
						)}
					</div>

					<div className="sidebar-footer">
						<div className="sidebar-user">
							<span className="user-avatar">{(userName || '?').charAt(0).toUpperCase()}</span>
							<span>{userName || t('sidebar.setName')}</span>
						</div>
						<button
							className="icon-btn"
							onClick={toggleTheme}
							title={theme === 'dark' ? t('sidebar.lightMode') : t('sidebar.darkMode')}
						>
							<Icon name={theme === 'dark' ? 'sun' : 'moon'}/>
						</button>
						<button
							className={`icon-btn ${currentView === 'settings' ? 'active' : ''}`}
							onClick={() => setCurrentView(currentView === 'settings' ? 'chat' : 'settings')}
							title={t('sidebar.settings')}
						>
							<Icon name="settings"/>
						</button>
					</div>
				</aside>
			)}

			<div className="main-content">
				{currentView === 'chat' && currentChatId && (
					<ChatView key={currentChatId} chatId={currentChatId} onChatUpdate={loadChats}/>
				)}
				{currentView === 'chat' && !currentChatId && (
					<div className="empty-app">
						<span className="brand-mark large">J</span>
						<h2>{t('app.emptyTitle')}</h2>
						<p>{t('app.emptyText')}</p>
						<button className="btn btn-primary" onClick={createNewChat}>
							<Icon name="plus"/>
							{t('app.startChat')}
						</button>
					</div>
				)}
				{currentView === 'settings' && (
					<SettingsView/>
				)}
				{currentView === 'debug' && (
					<DebugView/>
				)}
			</div>

			<ConfirmModal
				isOpen={chatToDelete !== null}
				title={t('app.deleteTitle')}
				message={t('app.deleteMessage')}
				onConfirm={confirmDelete}
				onCancel={closeDeleteModal}
				confirmText={t('app.deleteConfirm')}
			/>

			<ConfirmModal
				isOpen={showClearAllModal}
				title={t('app.clearTitle')}
				message={t('app.clearMessage')}
				onConfirm={confirmClearAllChats}
				onCancel={closeClearAllModal}
				confirmText={t('app.clearConfirm')}
			/>

			<UpdateModal
				isOpen={showUpdateModal}
				version={updateVersion}
				isDownloading={updateDownloading}
				downloadProgress={updateProgress}
				isReady={updateReady}
				error={updateError}
				onDownload={handleDownloadUpdate}
				onInstall={handleInstallUpdate}
				onDismiss={handleDismissUpdate}
				forceUpdate={forceUpdate}
			/>
		</div>
	);
}
