import type {JSX} from 'react';
import {useEffect, useMemo, useState} from 'react';
import type {Chat, DebugLogEntry} from '../types';
import './DebugView.css';

interface DebugRunGroup {
	id: string;
	chatId?: string;
	provider?: 'claude' | 'openai';
	logs: DebugLogEntry[];
	firstTimestamp: string;
	lastTimestamp: string;
	queryCount: number;
	toolCount: number;
	errorCount: number;
	infoCount: number;
	apiCount: number;
	totalDurationMs?: number;
	status: 'running' | 'completed' | 'failed' | 'background';
}

function isTerminalCompletedLog(log: DebugLogEntry): boolean {
	if (log.status !== 'completed') {
		return false;
	}
	if (log.meta?.terminal === true || log.meta?.terminal === 'true') {
		return true;
	}
	if (log.category === 'TanStack AI' && /^Stream finished\b/i.test(log.message)) {
		return true;
	}
	return (
		log.message === 'AI stream finished with final result'
		|| log.message === 'Synchronous send-message request finished'
		|| log.message === 'AI requested clarification'
	);
}

function isThinkingLog(log: DebugLogEntry): boolean {
	return log.category === 'AI Thinking' && log.phase === 'stream';
}

function collapseThinkingLogs(logs: DebugLogEntry[]): DebugLogEntry[] {
	const thinkingLogs = logs.filter(isThinkingLog);
	if (thinkingLogs.length === 0) {
		return logs;
	}

	const latestThinkingLog         = thinkingLogs[thinkingLogs.length - 1];
	const completedSteps            = thinkingLogs.filter((log) => /finished/i.test(log.message)).length;
	const startedSteps              = thinkingLogs.filter((log) => log.status === 'started').length;
	const summaryMessage            = latestThinkingLog.message.includes('No visible thinking steps')
		? latestThinkingLog.message
		: (completedSteps > 0 ? `Thinking updates (${completedSteps} completed step${completedSteps === 1 ? '' : 's'})` : 'Thinking in progress');
	const summaryDetails            = [
		`Updates: ${thinkingLogs.length}`,
		`Completed steps: ${completedSteps}`,
		`Started events: ${startedSteps}`,
		'',
		'Latest update:',
		latestThinkingLog.details || latestThinkingLog.message,
	].join('\n');
	const summaryLog: DebugLogEntry = {
		...latestThinkingLog,
		id        : `${latestThinkingLog.runId || latestThinkingLog.chatId || 'debug'}:thinking-summary`,
		message   : summaryMessage,
		details   : summaryDetails,
		status    : completedSteps > 0 ? 'info' : latestThinkingLog.status,
		durationMs: undefined,
		meta      : {
			...latestThinkingLog.meta,
			thinkingUpdates: thinkingLogs.length,
			thinkingSteps  : completedSteps,
		},
	};

	const collapsed: DebugLogEntry[] = [];
	let insertedSummary              = false;
	for (const log of logs) {
		if (isThinkingLog(log)) {
			if (!insertedSummary && log.id === latestThinkingLog.id) {
				collapsed.push(summaryLog);
				insertedSummary = true;
			}
			continue;
		}
		collapsed.push(log);
	}

	if (!insertedSummary) {
		collapsed.push(summaryLog);
	}

	return collapsed;
}

export function DebugView(): JSX.Element {
	const [logs, setLogs]                                       = useState<DebugLogEntry[]>([]);
	const [filter, setFilter]                                   = useState('');
	const [typeFilter, setTypeFilter]                           = useState<string>('all');
	const [autoScroll, setAutoScroll]                           = useState(true);
	const [chats, setChats]                                     = useState<Chat[]>([]);
	const [selectedChatId, setSelectedChatId]                   = useState<string>('all');
	const [workingSummary, setWorkingSummary]                   = useState<string>('');
	const [workingSummaryUpdatedAt, setWorkingSummaryUpdatedAt] = useState<string>('');
	const [workingSummaryError, setWorkingSummaryError]         = useState<string>('');
	const [selectedRunId, setSelectedRunId]                     = useState<string>('');
	const [selectedLogId, setSelectedLogId]                     = useState<string>('');

	useEffect(() => {
		const unsubscribe = window.electronAPI.onDebugLog((log: DebugLogEntry) => {
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
		if (autoScroll) {
			const eventsContainer = document.querySelector('.debug-events-list');
			if (eventsContainer) {
				eventsContainer.scrollTop = eventsContainer.scrollHeight;
			}
		}
	}, [logs, selectedRunId, autoScroll]);

	async function loadChats(): Promise<void> {
		try {
			const allChats = await window.electronAPI.getChats();
			setChats(allChats);
		} catch (error) {
			// Non-fatal
		}
	}

	async function refreshWorkingSummary(chatId: string): Promise<void> {
		if (chatId === 'all') {
			setWorkingSummary('');
			setWorkingSummaryUpdatedAt('');
			setWorkingSummaryError('');
			return;
		}
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
		const exportPayload = JSON.stringify(filteredLogs, null, 2);
		const blob          = new Blob([exportPayload], {type: 'application/json'});
		const url           = URL.createObjectURL(blob);
		const a             = document.createElement('a');
		a.href              = url;
		a.download          = `debug-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	const filteredLogs = useMemo(() => logs.filter((log) => {
		if (selectedChatId !== 'all' && log.chatId !== selectedChatId) {
			return false;
		}
		if (typeFilter !== 'all' && log.type !== typeFilter) {
			return false;
		}
		if (filter) {
			const searchTerm = filter.toLowerCase();
			return (
				log.message.toLowerCase().includes(searchTerm) ||
				log.category.toLowerCase().includes(searchTerm) ||
				(log.details && log.details.toLowerCase().includes(searchTerm)) ||
				(log.runId && log.runId.toLowerCase().includes(searchTerm)) ||
				(log.toolName && log.toolName.toLowerCase().includes(searchTerm)) ||
				(log.provider && log.provider.toLowerCase().includes(searchTerm)) ||
				(log.phase && log.phase.toLowerCase().includes(searchTerm))
			);
		}
		return true;
	}), [logs, selectedChatId, typeFilter, filter]);

	const statusSourceLogs = useMemo(() => logs.filter((log) => {
		return !(selectedChatId !== 'all' && log.chatId !== selectedChatId);

	}), [logs, selectedChatId]);

	const runStatusById = useMemo(() => {
		const statuses = new Map<string, DebugRunGroup['status']>();
		for (const log of statusSourceLogs) {
			const groupId = log.runId || `background:${log.chatId || 'global'}`;
			const current = statuses.get(groupId) || (groupId.startsWith('background:') ? 'background' : 'running');
			if (current === 'failed') {
				continue;
			}
			if (log.status === 'failed') {
				statuses.set(groupId, 'failed');
				continue;
			}
			if (isTerminalCompletedLog(log)) {
				statuses.set(groupId, 'completed');
				continue;
			}
			if (!statuses.has(groupId)) {
				statuses.set(groupId, current);
			}
		}
		return statuses;
	}, [statusSourceLogs]);

	const runGroups = useMemo(() => {
		const grouped    = new Map<string, DebugRunGroup>();
		const sortedLogs = [...filteredLogs].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		for (const log of sortedLogs) {
			const groupId  = log.runId || `background:${log.chatId || 'global'}`;
			const existing = grouped.get(groupId);
			if (!existing) {
				grouped.set(groupId, {
					id             : groupId,
					chatId         : log.chatId,
					provider       : log.provider,
					logs           : [log],
					firstTimestamp : log.timestamp,
					lastTimestamp  : log.timestamp,
					queryCount     : log.type === 'query' ? 1 : 0,
					toolCount      : log.type === 'tool' ? 1 : 0,
					errorCount     : log.type === 'error' ? 1 : 0,
					infoCount      : log.type === 'info' ? 1 : 0,
					apiCount       : log.type === 'api' ? 1 : 0,
					totalDurationMs: log.durationMs,
					status         : runStatusById.get(groupId) || (groupId.startsWith('background:') ? 'background' : 'running'),
				});
				continue;
			}
			existing.logs.push(log);
			existing.lastTimestamp = log.timestamp;
			if (log.type === 'query') existing.queryCount += 1;
			if (log.type === 'tool') existing.toolCount += 1;
			if (log.type === 'error') existing.errorCount += 1;
			if (log.type === 'info') existing.infoCount += 1;
			if (log.type === 'api') existing.apiCount += 1;
			if (log.durationMs && (!existing.totalDurationMs || log.durationMs > existing.totalDurationMs)) {
				existing.totalDurationMs = log.durationMs;
			}
			if (log.provider && !existing.provider) {
				existing.provider = log.provider;
			}
			existing.status = runStatusById.get(groupId) || existing.status;
		}
		return Array.from(grouped.values()).sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
	}, [filteredLogs, runStatusById]);

	useEffect(() => {
		if (runGroups.length === 0) {
			setSelectedRunId('');
			return;
		}
		if (!selectedRunId || !runGroups.some((group) => group.id === selectedRunId)) {
			setSelectedRunId(runGroups[0].id);
		}
	}, [runGroups, selectedRunId]);

	const selectedRun     = runGroups.find((group) => group.id === selectedRunId) || null;
	const selectedRunLogs = useMemo(() => collapseThinkingLogs(selectedRun?.logs || []), [selectedRun]);
	const summaryChatId   = selectedChatId !== 'all' ? selectedChatId : (selectedRun?.chatId || '');

	useEffect(() => {
		if (!summaryChatId) {
			setWorkingSummary('');
			setWorkingSummaryUpdatedAt('');
			setWorkingSummaryError('');
			return;
		}
		refreshWorkingSummary(summaryChatId);
	}, [summaryChatId]);

	useEffect(() => {
		if (selectedRunLogs.length === 0) {
			setSelectedLogId('');
			return;
		}
		if (!selectedLogId || !selectedRunLogs.some((log) => log.id === selectedLogId)) {
			setSelectedLogId(selectedRunLogs[selectedRunLogs.length - 1].id);
		}
	}, [selectedRunLogs, selectedLogId]);

	const selectedLog = selectedRunLogs.find((log) => log.id === selectedLogId) || null;

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
				return '•';
		}
	}

	function getRunTitle(run: DebugRunGroup): string {
		if (run.id.startsWith('background:')) {
			return run.chatId ? `Background logs for ${run.chatId}` : 'Background logs';
		}
		return run.id;
	}

	function getStatusClass(status: DebugRunGroup['status']): string {
		return `debug-run-status-${status}`;
	}

	function formatDuration(durationMs?: number): string {
		if (!durationMs || durationMs <= 0) {
			return 'n/a';
		}
		if (durationMs < 1000) {
			return `${durationMs} ms`;
		}
		return `${(durationMs / 1000).toFixed(2)} s`;
	}

	function renderMeta(meta?: DebugLogEntry['meta']): JSX.Element | null {
		if (!meta || Object.keys(meta).length === 0) {
			return null;
		}
		return (
			<div className="debug-detail-meta-grid">
				{Object.entries(meta).map(([key, value]) => (
					<div key={key} className="debug-detail-meta-item">
						<div className="debug-detail-meta-key">{key}</div>
						<div className="debug-detail-meta-value">{String(value)}</div>
					</div>
				))}
			</div>
		);
	}

	return (
		<div className="debug-view">
			<div className="debug-header">
				<div>
					<h2>Debug Console</h2>
					<div className="debug-subtitle">Run-based trace view for AI requests, tools, latency, and chat memory</div>
				</div>
				<div className="debug-controls">
					<select
						className="debug-type-filter"
						value={selectedChatId}
						onChange={(event) => setSelectedChatId(event.target.value)}
						title="Filter logs by chat"
					>
						<option value="all">All chats</option>
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
							if (selectedChatId && selectedChatId !== 'all') {
								await clearWorkingSummary(selectedChatId);
							}
						}}
						disabled={!selectedChatId || selectedChatId === 'all'}
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
					{selectedChatId === 'all' && summaryChatId && (
						<div className="debug-working-summary-meta">Following selected run chat automatically.</div>
					)}
					{selectedChatId === 'all' && !summaryChatId && (
						<div className="debug-working-summary-meta">Select a run or choose a chat to inspect memory.</div>
					)}
					{summaryChatId && workingSummaryUpdatedAt && (
						<div className="debug-working-summary-meta">
							Updated: {new Date(workingSummaryUpdatedAt).toLocaleString()}
						</div>
					)}
				</div>
				{workingSummaryError && (
					<div className="debug-working-summary-error">⚠ {workingSummaryError}</div>
				)}
				<pre className="debug-working-summary-content">
					{!summaryChatId
						? '(select a run or a chat to inspect working summary)'
						: (workingSummary?.trim() ? workingSummary : '(empty)')}
				</pre>
			</div>

			<div className="debug-stats">
				<span>Total: {logs.length}</span>
				<span>Filtered: {filteredLogs.length}</span>
				<span>Runs: {runGroups.length}</span>
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

			<div className="debug-content">
				<aside className="debug-runs-panel">
					<div className="debug-panel-title">Runs</div>
					<div className="debug-runs-list">
						{runGroups.length === 0 && (
							<div className="debug-empty">
								{logs.length === 0
									? 'No debug logs yet. Start a conversation to see activity.'
									: 'No runs match your filter.'}
							</div>
						)}
						{runGroups.map((run) => (
							<button
								key={run.id}
								type="button"
								className={`debug-run-card ${selectedRunId === run.id ? 'debug-run-card-active' : ''}`}
								onClick={() => setSelectedRunId(run.id)}
							>
								<div className="debug-run-card-top">
									<div className="debug-run-card-title">{getRunTitle(run)}</div>
									<div className={`debug-run-status ${getStatusClass(run.status)}`}>{run.status}</div>
								</div>
								<div className="debug-run-card-meta">
									<span>{run.provider || 'system'}</span>
									<span>{new Date(run.lastTimestamp).toLocaleTimeString()}</span>
									<span>{formatDuration(run.totalDurationMs)}</span>
								</div>
								<div className="debug-run-card-stats">
									<span>Q {run.queryCount}</span>
									<span>T {run.toolCount}</span>
									<span>E {run.errorCount}</span>
									<span>L {run.logs.length}</span>
								</div>
							</button>
						))}
					</div>
				</aside>

				<section className="debug-main-panel">
					{!selectedRun && (
						<div className="debug-empty">Select a run to inspect events.</div>
					)}
					{selectedRun && (
						<>
							<div className="debug-run-overview">
								<div className="debug-panel-title">Run Overview</div>
								<div className="debug-run-overview-grid">
									<div className="debug-run-overview-card">
										<div className="debug-run-overview-label">Run ID</div>
										<div className="debug-run-overview-value">{selectedRun.id}</div>
									</div>
									<div className="debug-run-overview-card">
										<div className="debug-run-overview-label">Provider</div>
										<div className="debug-run-overview-value">{selectedRun.provider || 'system'}</div>
									</div>
									<div className="debug-run-overview-card">
										<div className="debug-run-overview-label">Duration</div>
										<div className="debug-run-overview-value">{formatDuration(selectedRun.totalDurationMs)}</div>
									</div>
									<div className="debug-run-overview-card">
										<div className="debug-run-overview-label">Status</div>
										<div className="debug-run-overview-value">{selectedRun.status}</div>
									</div>
								</div>
								<div className="debug-run-badges">
									<span className="debug-badge">Queries: {selectedRun.queryCount}</span>
									<span className="debug-badge">Tools: {selectedRun.toolCount}</span>
									<span className="debug-badge">Errors: {selectedRun.errorCount}</span>
									<span className="debug-badge">API: {selectedRun.apiCount}</span>
									<span className="debug-badge">Events: {selectedRun.logs.length}</span>
								</div>
							</div>

							<div className="debug-main-columns">
								<div className="debug-events-panel">
									<div className="debug-panel-title">Events</div>
									<div className="debug-events-list">
										{selectedRunLogs.map((log) => (
											<button
												key={log.id}
												type="button"
												className={`debug-log ${getLogTypeClass(log.type)} ${selectedLogId === log.id ? 'debug-log-active' : ''}`}
												onClick={() => setSelectedLogId(log.id)}
											>
												<div className="debug-log-header">
													<span className="debug-log-icon">{getLogTypeIcon(log.type)}</span>
													<span className="debug-log-timestamp">{new Date(log.timestamp).toLocaleTimeString()}</span>
													<span className="debug-log-type">{log.type}</span>
													<span className="debug-log-category">{log.category}</span>
													{log.phase && <span className="debug-log-phase">{log.phase}</span>}
												</div>
												<div className="debug-log-message">{log.message}</div>
												<div className="debug-log-inline-meta">
													{log.toolName && <span>{log.toolName}</span>}
													{typeof log.rowCount === 'number' && <span>{log.rowCount} rows</span>}
													{typeof log.durationMs === 'number' && <span>{formatDuration(log.durationMs)}</span>}
													{log.status && <span>{log.status}</span>}
												</div>
											</button>
										))}
									</div>
								</div>

								<div className="debug-detail-panel">
									<div className="debug-panel-title">Selected Event</div>
									{!selectedLog && (
										<div className="debug-empty">Select an event to inspect details.</div>
									)}
									{selectedLog && (
										<div className="debug-detail-card">
											<div className="debug-detail-header">
												<div>
													<div className="debug-detail-title">{selectedLog.category}</div>
													<div className="debug-detail-subtitle">{selectedLog.message}</div>
												</div>
												<div className={`debug-run-status ${getStatusClass(selectedRun.status)}`}>{selectedLog.type}</div>
											</div>
											<div className="debug-detail-meta-row">
												<span>Time: {new Date(selectedLog.timestamp).toLocaleString()}</span>
												{selectedLog.phase && <span>Phase: {selectedLog.phase}</span>}
												{selectedLog.provider && <span>Provider: {selectedLog.provider}</span>}
												{selectedLog.toolName && <span>Tool: {selectedLog.toolName}</span>}
												{typeof selectedLog.durationMs === 'number' &&
													<span>Duration: {formatDuration(selectedLog.durationMs)}</span>}
											</div>
											{renderMeta(selectedLog.meta)}
											<div className="debug-detail-section">
												<div className="debug-detail-section-title">Details</div>
												<pre className="debug-detail-pre">{selectedLog.details || '(no details)'}</pre>
											</div>
										</div>
									)}
								</div>
							</div>
						</>
					)}
				</section>
			</div>
		</div>
	);
}
