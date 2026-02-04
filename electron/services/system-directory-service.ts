export interface SystemDirectorySystem {
	name: string;
	systemKey: string;
	project?: string;
	inSystems?: boolean;
	isDev: boolean;
	isRestore: boolean;
	release?: string;
	targetRelease?: string;
	nextRelease?: string;
	systemPath?: string;
	systemUrl?: string;
	systemUrlWithProtocol?: string;
	systemUrlAlias?: string;
	databaseName: string;
	backupDatabaseName?: string;
	serverHost: string;
	allowSystemDelete?: boolean;
	allowDatabaseDelete?: boolean;
}

export interface SystemDirectoryResponse {
	status: number;
	message?: string;
	error_code?: number;
	data?: {
		systems?: SystemDirectorySystem[];
	};
}

export class SystemDirectoryService {
	private readonly cacheTtlMs: number;
	private readonly fetchTimeoutMs: number;
	private cache: Map<string, { fetchedAtMs: number; systems: SystemDirectorySystem[] }> = new Map();

	constructor(options?: { cacheTtlMs?: number; fetchTimeoutMs?: number }) {
		this.cacheTtlMs     = options?.cacheTtlMs ?? 60_000;
		this.fetchTimeoutMs = options?.fetchTimeoutMs ?? 12_000;
	}

	private buildCacheKey(statuses: string[]): string {
		return statuses.slice().sort().join(',');
	}

	private normalizeStatuses(statuses?: string[]): string[] {
		const s = (statuses && statuses.length > 0)
			? statuses
			: ['active', 'restore'];
		return Array.from(new Set(s.map((v) => String(v).trim()).filter(Boolean)));
	}

	async getSystems(statuses?: string[]): Promise<SystemDirectorySystem[]> {
		const normalized = this.normalizeStatuses(statuses);
		const cacheKey   = this.buildCacheKey(normalized);

		const cached = this.cache.get(cacheKey);
		if (cached && (Date.now() - cached.fetchedAtMs) < this.cacheTtlMs) {
			return cached.systems;
		}

		const controller = new AbortController();
		const timeout    = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

		try {
			const url      = `https://api.spysystem.dk/v1/system?status=${encodeURIComponent(normalized.join(','))}`;
			const response = await fetch(url, {
				method : 'GET',
				headers: {
					'Accept': 'application/json',
				},
				signal : controller.signal,
			});

			if (!response.ok) {
				throw new Error(`SystemDirectory API error: ${response.status} ${response.statusText}`);
			}

			const json    = (await response.json()) as SystemDirectoryResponse;
			const systems = (json.data?.systems ?? [])
				.filter((s): s is SystemDirectorySystem => !!s && typeof s === 'object')
				.map((s) => ({
					...s,
					// Defensive normalization: enforce types on fields we depend on.
					isDev        : !!(s as any).isDev,
					isRestore    : !!(s as any).isRestore,
					release      : (s as any).release !== undefined && (s as any).release !== null ? String((s as any).release) : undefined,
					targetRelease: (s as any).targetRelease !== undefined && (s as any).targetRelease !== null ? String((s as any).targetRelease) : undefined,
					nextRelease  : (s as any).nextRelease !== undefined && (s as any).nextRelease !== null ? String((s as any).nextRelease) : undefined,
				}));

			this.cache.set(cacheKey, {fetchedAtMs: Date.now(), systems});
			return systems;
		} catch (error) {
			// If fetch fails but we have cached data, return it as a best-effort fallback.
			if (cached) {
				return cached.systems;
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
}

