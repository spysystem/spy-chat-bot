import {app} from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import {LocalRepoService} from './local-repo-service';
import {SecureStorageService} from './secure-storage-service';

// Ripgrep binary path from @vscode/ripgrep package.
// In a packaged Electron app the binary lives inside app.asar, which the OS
// cannot execute directly. electron-builder's asarUnpack extracts it to
// app.asar.unpacked/, so we need to rewrite the path accordingly.
let rgPath: string | null = null;

async function getRipgrepPath(): Promise<string> {
	if (rgPath) {
		return rgPath;
	}
	const rgModule   = await import('@vscode/ripgrep');
	let resolvedPath = rgModule.rgPath;
	if (resolvedPath.includes('app.asar')) {
		resolvedPath = resolvedPath.replace('app.asar', 'app.asar.unpacked');
	}
	rgPath = resolvedPath;
	return rgPath;
}

export interface GitHubConfig {
	token: string;
	owner: string;
	repo: string;
	branch: string;
}

/**
 * GitHub configuration (encrypted) plus code access. When Local Git Sync is configured,
 * code tools go through `localRepo`; the GitHub REST API is only a fallback for users
 * without a local clone.
 */
export class GitHubService {
	readonly localRepo: LocalRepoService;
	private readonly configPath: string;
	private readonly secureStorage: SecureStorageService;
	private config: GitHubConfig | null = null;
	private localRepoUrl: string | null = null;

	constructor(secureStorage: SecureStorageService) {
		this.configPath    = path.join(app.getPath('userData'), 'github-config.json');
		this.secureStorage = secureStorage;
		this.localRepo     = new LocalRepoService({
			rootDir : path.join(app.getPath('userData'), 'repos'),
			getToken: async () => (await this.getConfig())?.token ?? null,
			getRipgrepPath,
		});
	}

	async getConfig(): Promise<GitHubConfig | null> {
		try {
			const encryptedData = await this.secureStorage.loadEncrypted('github-config');
			if (encryptedData) {
				this.config = JSON.parse(encryptedData);
				return this.config;
			}
			return null;
		} catch {
			return null;
		}
	}

	async saveConfig(config: GitHubConfig): Promise<void> {
		await this.secureStorage.saveEncrypted('github-config', JSON.stringify(config));

		// Keep empty placeholder file for compatibility
		const safeConfig = {token: '', owner: '', repo: '', branch: ''};
		await fs.writeFile(this.configPath, JSON.stringify(safeConfig, null, 2), 'utf-8');
		this.config = config;
	}

	setLocalRepoUrl(url: string | null): void {
		this.localRepoUrl = url && url.trim() !== '' ? url.trim() : null;
	}

	getLocalRepoUrl(): string | null {
		return this.localRepoUrl;
	}

	/**
	 * The chat's branch, or undefined for the repository's own default branch. The stored
	 * GitHub config has a `branch` field, but it is not editable in Settings and silently
	 * defaulted to "main", so it is deliberately not used here.
	 */
	async resolveBranch(branchOverride?: string): Promise<string | undefined> {
		return branchOverride?.trim() || undefined;
	}

	private getAuthorizationHeader(): string {
		if (!this.config) {
			throw new Error('GitHub not configured');
		}
		return `Bearer ${this.config.token.trim()}`;
	}

	async validateConfig(): Promise<{ valid: boolean; error?: string; user?: string }> {
		if (!this.config) {
			const config = await this.getConfig();
			if (!config) {
				return {valid: false, error: 'GitHub not configured'};
			}
		}

		try {
			const headers  = {
				'Authorization'       : this.getAuthorizationHeader(),
				'Accept'              : 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent'          : 'Sporge-Jorgen-App',
			};
			const response = await fetch('https://api.github.com/user', {headers});
			if (!response.ok) {
				const errorText = await response.text();
				return {valid: false, error: `Authentication failed: ${response.status} - ${errorText}`};
			}
			const user = await response.json() as { login: string };

			if (this.config!.owner && this.config!.repo) {
				const repoResponse = await fetch(`https://api.github.com/repos/${this.config!.owner}/${this.config!.repo}`, {headers});
				if (!repoResponse.ok) {
					return {valid: false, error: `Cannot access repository ${this.config!.owner}/${this.config!.repo}`};
				}
			}

			return {valid: true, user: user.login};
		} catch (error) {
			return {valid: false, error: String(error)};
		}
	}

	private async githubRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
		if (!this.config) {
			const config = await this.getConfig();
			if (!config) {
				throw new Error('GitHub not configured');
			}
		}

		const response = await fetch(`https://api.github.com${endpoint}`, {
			...options,
			headers: {
				'Authorization'       : this.getAuthorizationHeader(),
				'Accept'              : 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent'          : 'Sporge-Jorgen-App',
				...options.headers,
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			if (response.status === 401) {
				throw new Error('GitHub API authentication failed (401). Check that the token in Settings is valid and not expired.');
			}
			throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
		}

		return await response.json();
	}

	private repoPath(): string {
		if (!this.config?.owner || !this.config?.repo) {
			throw new Error('GitHub repository (owner/repo) is not configured');
		}
		return `/repos/${this.config.owner}/${this.config.repo}`;
	}

	/** GitHub code search only indexes the default branch, so this is a coarse fallback. */
	async searchCodeRemote(query: string): Promise<Array<{ path: string; matches: string[] }>> {
		await this.getConfig();
		const searchQuery = encodeURIComponent(`${query} repo:${this.config?.owner}/${this.config?.repo}`);
		const data        = await this.githubRequest(`/search/code?q=${searchQuery}&per_page=20`, {
			headers: {'Accept': 'application/vnd.github.text-match+json'},
		});
		return data.items.map((item: any) => ({
			path   : item.path,
			matches: item.text_matches?.map((m: any) => m.fragment || '') || [],
		}));
	}

	async getFileContentRemote(filePath: string, branch?: string): Promise<string> {
		await this.getConfig();
		const encodedPath = encodeURIComponent(filePath.replace(/^\/+/, '')).replace(/%2F/g, '/');
		const ref         = branch ? `?ref=${encodeURIComponent(branch)}` : '';
		const data        = await this.githubRequest(`${this.repoPath()}/contents/${encodedPath}${ref}`);
		if (Array.isArray(data) || data.type !== 'file') {
			throw new Error('Path is not a file');
		}
		return Buffer.from(data.content, 'base64').toString('utf-8');
	}

	async listFilesRemote(directoryPath: string = '', branch?: string): Promise<Array<{ path: string; type: 'file' | 'dir' }>> {
		await this.getConfig();
		const encodedPath = directoryPath ? encodeURIComponent(directoryPath.replace(/^\/+/, '')).replace(/%2F/g, '/') : '';
		const ref         = branch ? `?ref=${encodeURIComponent(branch)}` : '';
		const data        = await this.githubRequest(`${this.repoPath()}/contents/${encodedPath}${ref}`);
		if (!Array.isArray(data)) {
			throw new Error('Path is not a directory');
		}
		return data.map((item: any) => ({
			path: item.path,
			type: item.type === 'dir' ? 'dir' : 'file',
		}));
	}
}
