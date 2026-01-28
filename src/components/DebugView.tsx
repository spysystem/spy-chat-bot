import type {JSX} from 'react';
import {useEffect, useState} from 'react';
import './DebugView.css';

interface DebugLog {
	timestamp: string;
	type: 'query' | 'tool' | 'api' | 'error' | 'info';
	category: string;
	message: string;
	details?: string;
}

export function DebugView(): JSX.Element {
	const [logs, setLogs]             = useState<DebugLog[]>([]);
	const [filter, setFilter]         = useState('');
	const [typeFilter, setTypeFilter] = useState<string>('all');
	const [autoScroll, setAutoScroll] = useState(true);

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
		if (autoScroll) {
			const logsContainer = document.querySelector('.debug-logs');
			if (logsContainer) {
				logsContainer.scrollTop = logsContainer.scrollHeight;
			}
		}
	}, [logs, autoScroll]);

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
