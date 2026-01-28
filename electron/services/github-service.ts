import * as fs from 'fs/promises';
import * as path from 'path';
import {app} from 'electron';

export interface GitHubConfig {
	token: string;
	owner: string;
	repo: string;
	branch: string;
}

export class GitHubService {
	private readonly configPath: string;
	private config: GitHubConfig | null = null;

	constructor() {
		this.configPath = path.join(app.getPath('userData'), 'github-config.json');
	}

	async getConfig(): Promise<GitHubConfig | null> {
		try {
			const data  = await fs.readFile(this.configPath, 'utf-8');
			this.config = JSON.parse(data);
			return this.config;
		} catch (error) {
			return null;
		}
	}

	async saveConfig(config: GitHubConfig): Promise<void> {
		await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
		this.config = config;
	}

	private getAuthorizationHeader(): string {
		if (!this.config) {
			throw new Error('GitHub not configured');
		}

		// Trim whitespace from token
		const token = this.config.token.trim();

		// Debug logging
		console.log('[GitHubService] Token prefix:', token.substring(0, 10) + '...');
		console.log('[GitHubService] Token length:', token.length);

		// Fine-grained tokens (github_pat_*) use Bearer, classic tokens (ghp_*) use token
		if (token.startsWith('github_pat_')) {
			console.log('[GitHubService] Using Bearer authentication (fine-grained token)');
			return `Bearer ${token}`;
		}
		console.log('[GitHubService] Using token authentication (classic token)');
		return `token ${token}`;
	}

	async validateConfig(): Promise<{ valid: boolean; error?: string; user?: string }> {
		if (!this.config) {
			const config = await this.getConfig();
			if (!config) {
				return {valid: false, error: 'GitHub not configured'};
			}
			this.config = config;
		}

		try {
			// Test token by fetching authenticated user
			const authHeader = this.getAuthorizationHeader();
			console.log('[GitHubService] Full auth header:', authHeader.substring(0, 20) + '...');

			const headers = {
				'Authorization'       : authHeader,
				'Accept'              : 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent'          : 'Sporge-Jorgen-App',
			};

			console.log('[GitHubService] Request headers:', JSON.stringify(headers, null, 2).substring(0, 200));

			const response = await fetch('https://api.github.com/user', {
				headers: headers,
			});

			console.log('[GitHubService] Response status:', response.status);

			if (!response.ok) {
				const errorText = await response.text();
				console.log('[GitHubService] Error response:', errorText);
				return {valid: false, error: `Authentication failed: ${response.status} - ${errorText}`};
			}

			const user = await response.json() as { login: string };

			// Test repository access
			const repoResponse = await fetch(`https://api.github.com/repos/${this.config.owner}/${this.config.repo}`, {
				headers: {
					'Authorization'       : this.getAuthorizationHeader(),
					'Accept'              : 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
				},
			});

			if (!repoResponse.ok) {
				return {valid: false, error: `Cannot access repository ${this.config.owner}/${this.config.repo}`};
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
			this.config = config;
		}

		const url      = `https://api.github.com${endpoint}`;
		const response = await fetch(url, {
			...options,
			headers: {
				'Authorization'       : this.getAuthorizationHeader(),
				'Accept'              : 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				...options.headers,
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
 
			// Special handling for 401 Bad credentials
			if (response.status === 401) {
				throw new Error(response.body + `    GitHub API authentication failed (401). Please check:\n1. Token is valid and not expired\n2. Token starts with 'ghp_' or 'github_pat_'\n3. Token has 'repo' scope enabled\n\nGenerate a new token at: https://github.com/settings/tokens`);
			}

			throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
		}

		return await response.json();
	}

	async searchCode(query: string): Promise<Array<{ path: string; matches: string[] }>> {
		if (!this.config) {
			const config = await this.getConfig();
			if (!config) {
				throw new Error('GitHub not configured');
			}
			this.config = config;
		}

		try {
			const searchQuery = encodeURIComponent(`${query} repo:${this.config.owner}/${this.config.repo}`);
			const data        = await this.githubRequest(`/search/code?q=${searchQuery}&per_page=10`, {
				headers: {
					'Accept': 'application/vnd.github.text-match+json',
				},
			});

			return data.items.map((item: any) => ({
				path   : item.path,
				matches: item.text_matches?.map((m: any) => m.fragment || '') || [],
			}));
		} catch (error) {
			console.error('[GitHubService] Search error:', error);
			throw error;
		}
	}

	async getFileContent(filePath: string): Promise<string> {
		if (!this.config) {
			const config = await this.getConfig();
			if (!config) {
				throw new Error('GitHub not configured');
			}
			this.config = config;
		}

		try {
			const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, '/');
			const data        = await this.githubRequest(
				`/repos/${this.config.owner}/${this.config.repo}/contents/${encodedPath}?ref=${this.config.branch}`,
			);
			
			if (Array.isArray(data) || data.type !== 'file') {
				throw new Error('Path is not a file');
			}

			// Decode base64 content
			return Buffer.from(data.content, 'base64').toString('utf-8');
		} catch (error) {
			console.error('[GitHubService] Get file error:', error);
			throw error;
		}
	}

	async listFiles(directoryPath: string = ''): Promise<Array<{ path: string; type: 'file' | 'dir' }>> {
		if (!this.config) {
			const config = await this.getConfig();
			if (!config) {
				throw new Error('GitHub not configured');
			}
			this.config = config;
		}

		try {
			const encodedPath = directoryPath ? encodeURIComponent(directoryPath).replace(/%2F/g, '/') : '';
			const data        = await this.githubRequest(
				`/repos/${this.config.owner}/${this.config.repo}/contents/${encodedPath}?ref=${this.config.branch}`,
			);

			if (!Array.isArray(data)) {
				throw new Error('Path is not a directory');
			}

			return data.map((item: any) => ({
				path: item.path,
				type: item.type === 'dir' ? 'dir' : 'file',
			}));
		} catch (error) {
			console.error('[GitHubService] List files error:', error);
			throw error;
		}
	}

	async getTree(recursive: boolean = false): Promise<Array<{ path: string; type: string }>> {
		if (!this.config) {
			const config = await this.getConfig();
			if (!config) {
				throw new Error('GitHub not configured');
			}
			this.config = config;
		}

		try {
			// Get the latest commit SHA for the branch
			const branchData = await this.githubRequest(
				`/repos/${this.config.owner}/${this.config.repo}/branches/${this.config.branch}`,
			);

			const treeSha = branchData.commit.commit.tree.sha;

			// Get the tree
			const treeData = await this.githubRequest(
				`/repos/${this.config.owner}/${this.config.repo}/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`,
			);

			return treeData.tree.map((item: any) => ({
				path: item.path || '',
				type: item.type || '',
			}));
		} catch (error) {
			console.error('[GitHubService] Get tree error:', error);
			throw error;
		}
	}
}
