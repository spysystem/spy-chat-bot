import {useState, useEffect, JSX} from 'react';
import {ChatView} from './components/ChatView';
import {SettingsView} from './components/SettingsView';
import {DebugView} from './components/DebugView';
import {ConfirmModal} from './components/ConfirmModal';
import {UpdateModal} from './components/UpdateModal';
import {useTheme} from './ThemeContext';
import type {Chat} from './types';
import './App.css';

type View = 'chat' | 'settings' | 'debug';

export function App(): JSX.Element {
	const {theme, toggleTheme}              = useTheme();
	// Check if URL hash is #debug to show debug view
	const initialView                       = window.location.hash === '#debug' ? 'debug' : 'chat';
	const [currentView, setCurrentView]     = useState<View>(initialView);
	const [chats, setChats]                 = useState<Chat[]>([]);
	const [currentChatId, setCurrentChatId] = useState<string | null>(null);
	const [chatToDelete, setChatToDelete]   = useState<string | null>(null);

	// Update modal state
	const [showUpdateModal, setShowUpdateModal]     = useState(false);
	const [updateVersion, setUpdateVersion]         = useState('');
	const [updateDownloading, setUpdateDownloading] = useState(false);
	const [updateProgress, setUpdateProgress]       = useState(0);
	const [updateReady, setUpdateReady]             = useState(false);
	const [updateError, setUpdateError]             = useState<string | undefined>();
	const [forceUpdate]                             = useState(true);

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

			// If branch is provided, update GitHub config with this branch
			if (branch) {
				try {
					const currentConfig = await window.electronAPI.getGitHubConfig();
					if (currentConfig) {
						await window.electronAPI.saveGitHubConfig({
							...currentConfig,
							branch: branch,
						});
						console.log(`Updated GitHub branch to: ${branch}`);
					}
				} catch (error) {
					console.error('Error updating GitHub branch:', error);
				}
			}

			if (database) {
				// Create new chat
				const newChat = await window.electronAPI.createChat(`Query: ${database}`);

				// Update chat with database name and branch
				await window.electronAPI.updateChat(newChat.id, [], newChat.title, database, branch || undefined);

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
			<div className="sidebar">
				<h1>SPØRGE JØRGEN</h1>

				<button className="new-chat-btn" onClick={createNewChat}>
					+ New Chat
				</button>

				<div className="chat-list">
					<div className="chat-list-header">Chats</div>
					{chats.map((chat) => (
						<div
							key={chat.id}
							className={`chat-item ${currentChatId === chat.id ? 'active' : ''}`}
							onClick={() => selectChat(chat.id)}
						>
							<div className="chat-item-content">
								<div className="chat-item-title">{chat.title}</div>
								<div className="chat-item-date">
									{new Date(chat.updatedAt).toLocaleDateString()}
								</div>
							</div>
							<button
								className="chat-item-delete"
								onClick={(event) => {
									event.stopPropagation();
									openDeleteModal(chat.id);
								}}
								title="Delete chat"
							>
								🗑️
							</button>
						</div>
					))}
				</div>

				<nav className="sidebar-nav">
					<button
						className={currentView === 'chat' ? 'active' : ''}
						onClick={() => setCurrentView('chat')}
					>
						💬 Chat
					</button>
					<button
						className={currentView === 'settings' ? 'active' : ''}
						onClick={() => setCurrentView('settings')}
					>
						⚙️ Settings
					</button>
					<button onClick={toggleTheme}>
						{theme === 'dark' ? '☀️' : '🌙'} {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
					</button>
				</nav>
			</div>

			<div className="main-content">
				{currentView === 'chat' && currentChatId && (
					<ChatView key={currentChatId} chatId={currentChatId} onChatUpdate={loadChats}/>
				)}
				{currentView === 'chat' && !currentChatId && (
					<div style={{
						display       : 'flex',
						flexDirection : 'column',
						alignItems    : 'center',
						justifyContent: 'center',
						height        : '100%',
						textAlign     : 'center',
						padding       : '40px',
						color         : 'var(--text-primary)',
					}}>
						<h2 style={{fontSize: '32px', marginBottom: '16px', fontWeight: '700'}}>No Chats Yet</h2>
						<p style={{fontSize: '16px', color: 'var(--text-secondary)', marginBottom: '24px'}}>
							Click "New Chat" to start a conversation
						</p>
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
				title="Delete Chat"
				message="Are you sure you want to delete this chat? This action cannot be undone."
				onConfirm={confirmDelete}
				onCancel={closeDeleteModal}
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
