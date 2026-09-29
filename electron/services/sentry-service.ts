import {SecureStorageService} from './secure-storage-service';

export interface SentryConfig {
	token: string;
	orgSlug: string;
	baseUrl: string;
}

export interface SentryIssueSummary {
	issue: string;
	title: string;
	count: number;
	firstSeen?: string;
	lastSeen?: string;
	project?: string;
	url: string;
}

const DEFAULT_ORG      = 'spy-aps';
const DEFAULT_BASE_URL = 'https://us.sentry.io';
const TIMEOUT_MS       = 20_000;
const MAX_FRAMES       = 20;

/**
 * Read-only access to SPY's Sentry. Customer systems tag their events with
 * `system_key`, matching the system directory's systemKey on the chat.
 */
export class SentryService {
	private readonly secureStorage: SecureStorageService;

	constructor(secureStorage: SecureStorageService) {
		this.secureStorage = secureStorage;
	}

	async getConfig(): Promise<SentryConfig | null> {
		const raw = await this.secureStorage.loadEncrypted('sentry-config');
		if (!raw) {
			return null;
		}
		try {
			const parsed = JSON.parse(raw) as Partial<SentryConfig>;
			if (!parsed.token) {
				return null;
			}
			return {
				token  : parsed.token,
				orgSlug: parsed.orgSlug || DEFAULT_ORG,
				baseUrl: (parsed.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
			};
		} catch {
			return null;
		}
	}

	/** Settings view: never hands the token back to the renderer. */
	async getPublicConfig(): Promise<{ hasToken: boolean; orgSlug: string; baseUrl: string }> {
		const config = await this.getConfig();
		return {hasToken: !!config, orgSlug: config?.orgSlug ?? DEFAULT_ORG, baseUrl: config?.baseUrl ?? DEFAULT_BASE_URL};
	}

	/** An empty token keeps the stored one, so the org or URL can be changed on their own. */
	async saveConfig(input: { token?: string; orgSlug?: string; baseUrl?: string }): Promise<void> {
		const existing = await this.getConfig();
		const token    = input.token?.trim() || existing?.token || '';
		if (!token) {
			throw new Error('A Sentry auth token is required');
		}
		await this.secureStorage.saveEncrypted('sentry-config', JSON.stringify({
			token,
			orgSlug: input.orgSlug?.trim() || DEFAULT_ORG,
			baseUrl: input.baseUrl?.trim() || DEFAULT_BASE_URL,
		}));
	}

	async isConfigured(): Promise<boolean> {
		return !!(await this.getConfig());
	}

	async validate(): Promise<{ valid: boolean; error?: string; organization?: string }> {
		try {
			const config = await this.requireConfig();
			const org    = await this.request<{ name: string }>(config, `/api/0/organizations/${encodeURIComponent(config.orgSlug)}/`);
			return {valid: true, organization: org.name};
		} catch (error) {
			return {valid: false, error: error instanceof Error ? error.message : String(error)};
		}
	}

	/** Issues with events in the period, counted for this system only, most frequent first. */
	async searchIssues(options: { systemKey?: string; query?: string; period: string; limit: number }): Promise<SentryIssueSummary[]> {
		const config = await this.requireConfig();
		const query  = ['event.type:error', options.systemKey ? `system_key:${quoteValue(options.systemKey)}` : '', options.query ?? '']
			.filter(Boolean)
			.join(' ');
		const params = new URLSearchParams();
		for (const field of ['issue', 'title', 'project', 'count()', 'min(timestamp)', 'max(timestamp)']) {
			params.append('field', field);
		}
		params.set('query', query);
		params.set('statsPeriod', options.period);
		params.set('sort', '-count()');
		params.set('per_page', String(options.limit));
		const result = await this.request<{ data: Array<Record<string, unknown>> }>(config, `/api/0/organizations/${encodeURIComponent(config.orgSlug)}/events/?${params}`);
		return (result.data ?? []).map((row) => ({
			issue    : String(row.issue ?? ''),
			title    : String(row.title ?? ''),
			count    : Number(row['count()'] ?? 0),
			firstSeen: row['min(timestamp)'] ? String(row['min(timestamp)']) : undefined,
			lastSeen : row['max(timestamp)'] ? String(row['max(timestamp)']) : undefined,
			project  : row.project ? String(row.project) : undefined,
			url      : this.issueUrl(config, String(row.issue ?? '')),
		}));
	}

	/** The most recent event of an issue (for this system when given), formatted for the model. */
	async describeIssue(issue: string, systemKey?: string): Promise<string> {
		const config  = await this.requireConfig();
		const org     = encodeURIComponent(config.orgSlug);
		const groupId = await this.resolveGroupId(config, issue);
		const group   = await this.request<Record<string, any>>(config, `/api/0/organizations/${org}/issues/${groupId}/`);

		const params = new URLSearchParams({full: 'true', per_page: '1'});
		if (systemKey) {
			params.set('query', `system_key:${quoteValue(systemKey)}`);
		}
		let events = await this.request<Array<Record<string, any>>>(config, `/api/0/organizations/${org}/issues/${groupId}/events/?${params}`);
		let scope  = systemKey ? `latest event for system ${systemKey}` : 'latest event';
		if (events.length === 0 && systemKey) {
			params.delete('query');
			events = await this.request<Array<Record<string, any>>>(config, `/api/0/organizations/${org}/issues/${groupId}/events/?${params}`);
			scope  = `no events for system ${systemKey} - latest event from any system`;
		}

		const lines = [
			`${group.shortId}: ${group.title}`,
			`Link: ${group.permalink || this.issueUrl(config, group.shortId)}`,
			`Status: ${group.status}${group.substatus ? ` (${group.substatus})` : ''} · Events (all systems): ${group.count} · First seen: ${group.firstSeen} · Last seen: ${group.lastSeen}`,
			group.culprit ? `Culprit: ${group.culprit}` : '',
		];
		if (events[0]) {
			lines.push('', `--- ${scope} ---`, formatEvent(events[0]));
		}
		return lines.filter((line) => line !== '').join('\n');
	}

	private async resolveGroupId(config: SentryConfig, issue: string): Promise<string> {
		const trimmed = issue.trim().replace(/^.*\/issues\//, '').replace(/\/.*$/, '');
		if (/^\d+$/.test(trimmed)) {
			return trimmed;
		}
		if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
			throw new Error(`Invalid Sentry issue id: ${issue}`);
		}
		const result = await this.request<{ groupId: string }>(config, `/api/0/organizations/${encodeURIComponent(config.orgSlug)}/shortids/${encodeURIComponent(trimmed.toUpperCase())}/`);
		return String(result.groupId);
	}

	private issueUrl(config: SentryConfig, shortId: string): string {
		return `https://${config.orgSlug}.sentry.io/issues/${encodeURIComponent(shortId)}/`;
	}

	private async requireConfig(): Promise<SentryConfig> {
		const config = await this.getConfig();
		if (!config) {
			throw new Error('Sentry is not configured. Add an auth token in Settings → Sentry.');
		}
		return config;
	}

	private async request<T>(config: SentryConfig, pathAndQuery: string): Promise<T> {
		const controller = new AbortController();
		const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			const response = await fetch(`${config.baseUrl}${pathAndQuery}`, {
				headers: {Authorization: `Bearer ${config.token}`, Accept: 'application/json'},
				signal : controller.signal,
			});
			if (!response.ok) {
				const body = (await response.text()).slice(0, 300);
				if (response.status === 401 || response.status === 403) {
					throw new Error(`Sentry rejected the token (${response.status}). It needs the event:read, org:read and project:read scopes.`);
				}
				throw new Error(`Sentry API error ${response.status}: ${body}`);
			}
			return await response.json() as T;
		} finally {
			clearTimeout(timer);
		}
	}
}

function quoteValue(value: string): string {
	return /^[\w.-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/** Server paths (/var/www/spy/<x>/<host>/..., /var/www/spy/code/.tmp/<release>/<build>/...) -> repository paths. */
function repoRelativePath(file: string): string {
	return file
		.replace(/^.*\/\.tmp\/[^/]+\/[^/]+\//, '')
		.replace(/^\/var\/www\/spy\/[^/]+\/[^/]+\//, '');
}

function formatEvent(event: Record<string, any>): string {
	const lines: string[] = [];
	lines.push(`Event ${event.eventID ?? event.id} at ${event.dateCreated ?? event.dateReceived ?? '?'}`);

	const tags = new Map<string, string>((event.tags ?? []).map((t: { key: string; value: string }) => [t.key, t.value]));
	const keep = ['system_key', 'environment', 'release', 'server_name', 'url', 'user_agent', 'browser', 'handled', 'level'];
	const tagLine = keep.filter((k) => tags.has(k)).map((k) => `${k}=${tags.get(k)}`).join(' · ');
	if (tagLine) {
		lines.push(`Tags: ${tagLine}`);
	}

	for (const entry of event.entries ?? []) {
		if (entry.type === 'exception') {
			for (const exception of (entry.data?.values ?? []).slice(-2)) {
				lines.push('', `${exception.type}: ${exception.value ?? ''}`);
				const frames      = (exception.stacktrace?.frames ?? []) as Array<Record<string, any>>;
				const inApp       = frames.filter((f) => f.inApp);
				const chosen      = (inApp.length > 0 ? inApp : frames).slice(-MAX_FRAMES).reverse();
				for (const frame of chosen) {
					const file    = repoRelativePath(frame.absPath || frame.filename || frame.module || '?');
					const context = (frame.context ?? []).find((c: [number, string]) => c[0] === frame.lineNo)?.[1]?.trim();
					lines.push(`  at ${frame.function ?? '?'} (${file}:${frame.lineNo ?? '?'})${context ? `\n     ${context}` : ''}`);
				}
			}
		} else if (entry.type === 'message' && entry.data?.formatted) {
			lines.push('', `Message: ${entry.data.formatted}`);
		} else if (entry.type === 'request' && entry.data) {
			lines.push('', `Request: ${entry.data.method ?? ''} ${entry.data.url ?? ''}`.trim());
		} else if (entry.type === 'breadcrumbs') {
			const crumbs = (entry.data?.values ?? []).slice(-8);
			if (crumbs.length > 0) {
				lines.push('', 'Last breadcrumbs:');
				for (const crumb of crumbs) {
					lines.push(`  ${crumb.timestamp ?? ''} ${crumb.category ?? ''} ${String(crumb.message ?? JSON.stringify(crumb.data ?? {})).slice(0, 200)}`);
				}
			}
		}
	}
	return lines.join('\n');
}
