import type {JSX} from 'react';
import {useEffect, useState} from 'react';
import type {Chat} from '../types';
import './DebugView.css';

interface DebugLog {
	timestamp: string;
	type: 'query' | 'tool' | 'api' | 'error' | 'info';
	category: string;
	message: string;
	details?: string;
}

export function DebugView(): JSX.Element {
	const [logs, setLogs]                                       = useState<DebugLog[]>([]);
	const [filter, setFilter]                                   = useState('');
	const [typeFilter, setTypeFilter]                           = useState<string>('all');
	const [autoScroll, setAutoScroll]                           = useState(true);
	const [chats, setChats]                                     = useState<Chat[]>([]);
	const [selectedChatId, setSelectedChatId]                   = useState<string>('');
	const [workingSummary, setWorkingSummary]                   = useState<string>('');
	const [workingSummaryUpdatedAt, setWorkingSummaryUpdatedAt] = useState<string>('');
	const [workingSummaryError, setWorkingSummaryError]         = useState<string>('');

	useEffect(() => {
		// Listen for debug logs
		const unsubscribe = window.electronAPI.onDebugLog((log: DebugLog) => {
			setLogs((previous) => [...previous, log]);
		});

		return () => {
			unsubscribe();
		};
	}, []);

	useEffect(() => {
		loadChats();
	}, []);

	useEffect(() => {
		if (!selectedChatId) {
			setWorkingSummary('');
			setWorkingSummaryUpdatedAt('');
			setWorkingSummaryError('');
			return;
		}
		refreshWorkingSummary(selectedChatId);
	}, [selectedChatId]);

	useEffect(() => {
		if (autoScroll) {
			const logsContainer = document.querySelector('.debug-logs');
			if (logsContainer) {
				logsContainer.scrollTop = logsContainer.scrollHeight;
			}
		}
	}, [logs, autoScroll]);

	async function loadChats(): Promise<void> {
		try {
			const allChats = await window.electronAPI.getChats();
			setChats(allChats);
			if (!selectedChatId && allChats.length > 0) {
				setSelectedChatId(allChats[0].id);
			}
		} catch (error) {
			// Non-fatal
		}
	}

	async function refreshWorkingSummary(chatId: string): Promise<void> {
		setWorkingSummaryError('');
		try {
			const chat = await window.electronAPI.getChat(chatId);
			const text = chat?.workingSummary?.text || '';
			setWorkingSummary(text);
			setWorkingSummaryUpdatedAt(chat?.workingSummary?.updatedAt || '');
		} catch (error) {
			setWorkingSummaryError(error instanceof Error ? error.message : String(error));
		}
	}

	async function clearWorkingSummary(chatId: string): Promise<void> {
		setWorkingSummaryError('');
		try {
			await window.electronAPI.clearWorkingSummary(chatId);
			await refreshWorkingSummary(chatId);
		} catch (error) {
			setWorkingSummaryError(error instanceof Error ? error.message : String(error));
		}
	}

	function clearLogs(): void {
		setLogs([]);
	}

	function exportLogs(): void {
		const logsText = logs
			.map((log) => {
				let text = `[${log.timestamp}] [${log.type.toUpperCase()}] ${log.category}: ${log.message}`;
				if (log.details) {
					text += `\n${log.details}\n`;
				}
				return text;
			})
			.join('\n');

		const blob = new Blob([logsText], {type: 'text/plain'});
		const url  = URL.createObjectURL(blob);
		const a    = document.createElement('a');
		a.href     = url;
		a.download = `debug-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
		a.click();
		URL.revokeObjectURL(url);
	}

	const filteredLogs = logs.filter((log) => {
		// Type filter
		if (typeFilter !== 'all' && log.type !== typeFilter) {
			return false;
		}

		// Text filter
		if (filter) {
			const searchTerm = filter.toLowerCase();
			return (
				log.message.toLowerCase().includes(searchTerm) ||
				log.category.toLowerCase().includes(searchTerm) ||
				(log.details && log.details.toLowerCase().includes(searchTerm))
			);
		}

		return true;
	});

	function getLogTypeClass(type: string): string {
		return `debug-log-${type}`;
	}

	function getLogTypeIcon(type: string): string {
		switch (type) {
			case 'query':
				return '🔍';
			case 'tool':
				return '🔧';
			case 'api':
				return '📡';
			case 'error':
				return '❌';
			case 'info':
				return 'ℹ️';
			default:
				return '📝';
		}
	}

	return (
		<div className="debug-view">
			<div className="debug-header">
				<h2>Debug Console</h2>
				<div className="debug-controls">
					<select
						className="debug-type-filter"
						value={selectedChatId}
						onChange={(event) => setSelectedChatId(event.target.value)}
						title="Select chat for Working Summary"
					>
						{chats.length === 0 && (
							<option value="">No chats</option>
						)}
						{chats.map((chat) => (
							<option key={chat.id} value={chat.id}>
								{chat.title}
							</option>
						))}
					</select>
					<button
						className="debug-button"
						onClick={async () => {
							await loadChats();
							if (selectedChatId) {
								await refreshWorkingSummary(selectedChatId);
							}
						}}
						title="Refresh chats and summary"
					>
						Refresh
					</button>
					<button
						className="debug-button"
						onClick={async () => {
							if (selectedChatId) {
								await clearWorkingSummary(selectedChatId);
							}
						}}
						disabled={!selectedChatId}
						title="Clear working summary for selected chat"
					>
						Clear Summary
					</button>
					<input
						type="text"
						className="debug-filter"
						placeholder="Filter logs..."
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
					/>
					<select
						className="debug-type-filter"
						value={typeFilter}
						onChange={(event) => setTypeFilter(event.target.value)}
					>
						<option value="all">All Types</option>
						<option value="query">Queries</option>
						<option value="tool">Tools</option>
						<option value="api">API Calls</option>
						<option value="error">Errors</option>
						<option value="info">Info</option>
					</select>
					<label className="debug-autoscroll">
						<input
							type="checkbox"
							checked={autoScroll}
							onChange={(event) => setAutoScroll(event.target.checked)}
						/>
						Auto-scroll
					</label>
					<button className="debug-button" onClick={clearLogs}>
						Clear
					</button>
					<button className="debug-button" onClick={exportLogs}>
						Export
					</button>
				</div>
			</div>

			<div className="debug-working-summary">
				<div className="debug-working-summary-header">
					<div className="debug-working-summary-title">Working Summary (Chat Memory)</div>
					{workingSummaryUpdatedAt && (
						<div className="debug-working-summary-meta">
							Updated: {new Date(workingSummaryUpdatedAt).toLocaleString()}
						</div>
					)}
				</div>
				{workingSummaryError && (
					<div className="debug-working-summary-error">⚠ {workingSummaryError}</div>
				)}
				<pre className="debug-working-summary-content">
					{workingSummary?.trim() ? workingSummary : '(empty)'}
				</pre>
			</div>

			<div className="debug-stats">
				<span>Total: {logs.length}</span>
				<span>Filtered: {filteredLogs.length}</span>
				<span className="debug-stat-queries">
					Queries: {logs.filter((log) => log.type === 'query').length}
				</span>
				<span className="debug-stat-tools">
					Tools: {logs.filter((log) => log.type === 'tool').length}
				</span>
				<span className="debug-stat-errors">
					Errors: {logs.filter((log) => log.type === 'error').length}
				</span>
			</div>

			<div className="debug-logs">
				{filteredLogs.length === 0 && (
					<div className="debug-empty">
						{logs.length === 0
							? 'No debug logs yet. Start a conversation to see activity.'
							: 'No logs match your filter.'}
					</div>
				)}
				{filteredLogs.map((log, index) => (
					<div key={index} className={`debug-log ${getLogTypeClass(log.type)}`}>
						<div className="debug-log-header">
							<span className="debug-log-icon">{getLogTypeIcon(log.type)}</span>
							<span className="debug-log-timestamp">{log.timestamp}</span>
							<span className="debug-log-type">{log.type}</span>
							<span className="debug-log-category">{log.category}</span>
						</div>
						<div className="debug-log-message">{log.message}</div>
						{log.details && (
							<details className="debug-log-details">
								<summary>Details</summary>
								<pre>{log.details}</pre>
							</details>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
