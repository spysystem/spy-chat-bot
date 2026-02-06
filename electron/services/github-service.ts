import {execFile, spawn} from 'child_process';
import {app} from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import {promisify} from 'util';
import {SecureStorageService} from './secure-storage-service';

// Ripgrep binary path from @vscode/ripgrep package
let rgPath: string | null = null;
async function getRipgrepPath(): Promise<string> {
	if (rgPath) {
		return rgPath;
	}
	try {
		// @vscode/ripgrep exports the path to the rg binary
		const rgModule = await import('@vscode/ripgrep');
		rgPath = rgModule.rgPath;
		return rgPath;
	} catch (error) {
		throw new Error(`Failed to load ripgrep: ${error}`);
	}
}

export interface GitHubConfig {
	token: string;
	owner: string;
	repo: string;
	branch: string;
}

export class GitHubService {
	private readonly configPath: string;
	private readonly secureStorage: SecureStorageService;
	private config: GitHubConfig | null              = null;
	private lastLocalSyncIso: string | null          = null;
	private localRepoUrl: string | null              = null;
	private worktreeLastSyncMs: Map<string, number>  = new Map<string, number>();
	private readonly worktreeFetchIntervalMs: number = 20 * 60 * 1000;
	private lastLocalSearchMeta: null | {
		branch: string;
		worktreePath: string;
		tokens: string[];
		mode: 'all' | 'any';
		pathSpecs: string[];
		durationMs: number;
	} = null;


	constructor(secureStorage: SecureStorageService) {
		this.configPath    = path.join(app.getPath('userData'), 'github-config.json');
		this.secureStorage = secureStorage;
	}

	async getConfig(): Promise<GitHubConfig | null> {
		try {
			// Load full config from encrypted storage
			const encryptedData = await this.secureStorage.loadEncrypted('github-config');

			if (encryptedData) {
				this.config = JSON.parse(encryptedData);
				return this.config;
			}

			return null;
		} catch (error) {
			return null;
		}
	}

	async saveConfig(config: GitHubConfig): Promise<void> {
		// Save entire config to encrypted storage
		await this.secureStorage.saveEncrypted('github-config', JSON.stringify(config));

		// Keep empty placeholder file for compatibility
		const safeConfig = {
			token : '',
			owner : '',
			repo  : '',
			branch: '',
		};

		await fs.writeFile(this.configPath, JSON.stringify(safeConfig, null, 2), 'utf-8');
		this.config = config;
	}

	setLocalRepoUrl(url: string | null): void {
		this.localRepoUrl = url && url.trim() !== '' ? url.trim() : null;
	}

	/**
	 * No-op: Ripgrep doesn't need file caching, so this is a placeholder for API compatibility.
	 */
	clearFileListCache(): void {
		// No-op: Ripgrep handles its own file enumeration very efficiently
	}

	getLocalRepoUrl(): string | null {
		return this.localRepoUrl;
	}

	getLocalRepoRoot(): string {
		return path.join(app.getPath('userData'), 'repos', 'spy');
	}

	getWorktreesRoot(): string {
		return path.join(app.getPath('userData'), 'repos', 'spy-worktrees');
	}

	async getLocalRepoStatus(): Promise<{ exists: boolean; repoPath: string; lastSyncIso?: string; url?: string }> {
		const repoPath = this.getLocalRepoRoot();
		try {
			await fs.access(repoPath);
			return {
				exists     : true,
				repoPath,
				lastSyncIso: this.lastLocalSyncIso || undefined,
				url        : this.localRepoUrl || undefined,
			};
		} catch {
			return {exists: false, repoPath, url: this.localRepoUrl || undefined};
		}
	}

	private async runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
		const execFileAsync = promisify(execFile);
		try {
			const result = await execFileAsync('git', args, {cwd});
			return {stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
		} catch (error) {
			const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
			// Handle "git not installed" error
			if (err.code === 'ENOENT') {
				throw new Error('Git is not installed or not in PATH. Please install Git from https://git-scm.com/downloads and restart the application.');
			}
			const stderr = err.stderr || err.message || 'Git command failed';
			throw new Error(stderr);
		}
	}

	private async runGitWithProgress(
		args: string[],
		cwd: string,
		onProgress?: (progress: { stage: string; percent?: number; message?: string }) => void,
	): Promise<{ stdout: string; stderr: string }> {
		return await new Promise((resolve, reject) => {
			const child      = spawn('git', args, {cwd});
			let stdout       = '';
			let stderr       = '';
			let stdoutBuffer = '';
			let stderrBuffer = '';

			const flushLines = (buffer: string, isError: boolean): string => {
				const lines     = buffer.split(/\r?\n/);
				const remainder = lines.pop() ?? '';
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) {
						continue;
					}
					this.parseGitProgress(trimmed, onProgress);
					if (isError) {
						stderr += trimmed + '\n';
					} else {
						stdout += trimmed + '\n';
					}
				}
				return remainder;
			};

			child.stdout?.on('data', (chunk) => {
				stdoutBuffer += chunk.toString();
				stdoutBuffer = flushLines(stdoutBuffer, false);
			});

			child.stderr?.on('data', (chunk) => {
				stderrBuffer += chunk.toString();
				stderrBuffer = flushLines(stderrBuffer, true);
			});

			child.on('error', (error: NodeJS.ErrnoException) => {
				// Handle "git not installed" error
				if (error.code === 'ENOENT') {
					reject(new Error('Git is not installed or not in PATH. Please install Git from https://git-scm.com/downloads and restart the application.'));
				} else {
					reject(error);
				}
			});

			child.on('close', (code) => {
				if (stdoutBuffer.trim()) {
					stdout += stdoutBuffer.trim() + '\n';
				}
				if (stderrBuffer.trim()) {
					stderr += stderrBuffer.trim() + '\n';
				}
				if (code === 0) {
					resolve({stdout: stdout.trim(), stderr: stderr.trim()});
				} else {
					reject(new Error(stderr.trim() || `Git command failed with code ${code}`));
				}
			});
		});
	}

	private async runGitWithExitCodes(
		args: string[],
		cwd: string,
		allowedExitCodes: number[] = [0],
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return await new Promise((resolve, reject) => {
			const child = spawn('git', args, {cwd});
			let stdout  = '';
			let stderr  = '';

			child.stdout?.on('data', (chunk) => {
				stdout += chunk.toString();
			});

			child.stderr?.on('data', (chunk) => {
				stderr += chunk.toString();
			});

			child.on('error', (error: NodeJS.ErrnoException) => {
				// Handle "git not installed" error
				if (error.code === 'ENOENT') {
					reject(new Error('Git is not installed or not in PATH. Please install Git from https://git-scm.com/downloads and restart the application.'));
				} else {
					reject(error);
				}
			});

			child.on('close', (code) => {
				const exitCode = typeof code === 'number' ? code : 1;
				if (allowedExitCodes.includes(exitCode)) {
					resolve({stdout: stdout.trim(), stderr: stderr.trim(), exitCode});
				} else {
					reject(new Error(stderr.trim() || `Git command failed with code ${exitCode}`));
				}
			});
		});
	}

	private parseGitProgress(
		line: string,
		onProgress?: (progress: { stage: string; percent?: number; message?: string }) => void,
	): void {
		if (!onProgress) {
			return;
		}

		const progressMatchers: Array<{ regex: RegExp; stage: string }> = [
			{regex: /Receiving objects:\s+(\d+)%/i, stage: 'Receiving objects'},
			{regex: /Resolving deltas:\s+(\d+)%/i, stage: 'Resolving deltas'},
			{regex: /Compressing objects:\s+(\d+)%/i, stage: 'Compressing objects'},
			{regex: /Checking out files:\s+(\d+)%/i, stage: 'Checking out files'},
		];

		for (const matcher of progressMatchers) {
			const match = line.match(matcher.regex);
			if (match) {
				const percent = Number(match[1]);
				onProgress({stage: matcher.stage, percent, message: line});
				return;
			}
		}

		if (line.toLowerCase().includes('fetching')) {
			onProgress({stage: 'Fetching', message: line});
		}
	}

	private async pathExists(targetPath: string): Promise<boolean> {
		try {
			await fs.access(targetPath);
			return true;
		} catch {
			return false;
		}
	}

	async ensureLocalRepo(
		url: string,
		options?: {
			fetch?: boolean;
			onProgress?: (progress: { stage: string; percent?: number; message?: string }) => void;
		},
	): Promise<{ repoPath: string }> {
		const repoPath = this.getLocalRepoRoot();
		const repoDir  = path.dirname(repoPath);
		await fs.mkdir(repoDir, {recursive: true});
		const fetch      = options?.fetch ?? true;
		const onProgress = options?.onProgress;

		// Get GitHub token for authenticated clone (private repos)
		let cloneUrl = url;
		try {
			const config = await this.getConfig();
			if (config?.token && url.includes('github.com')) {
				// Embed token in URL for authentication: https://TOKEN@github.com/owner/repo.git
				const urlObj = new URL(url);
				urlObj.username = config.token;
				urlObj.password = 'x-oauth-basic';
				cloneUrl = urlObj.toString();
				console.log('[GitHubService] Using authenticated clone URL');
			}
		} catch {
			// Continue without token - will fail for private repos
			console.log('[GitHubService] No GitHub token available, using unauthenticated clone');
		}

		if (!(await this.pathExists(repoPath))) {
			onProgress?.({stage: 'Cloning repository'});
			// Enable long paths for Windows (fixes "Filename too long" errors)
			// This must be set BEFORE cloning
			try {
				await this.runGit(['config', '--global', 'core.longpaths', 'true'], repoDir);
			} catch {
				// Ignore if this fails - not all systems need it
			}
			// Use --no-single-branch to fetch all branches, not just the default
			await this.runGitWithProgress(['clone', '--progress', '--no-single-branch', cloneUrl, repoPath], repoDir, onProgress);
			// Also set longpaths in the repo config
			try {
				await this.runGit(['-C', repoPath, 'config', 'core.longpaths', 'true'], repoPath);
			} catch {
				// Ignore
			}
			// Store credentials in Windows Credential Manager for future fetches
			try {
				await this.runGit(['-C', repoPath, 'config', 'credential.helper', 'manager'], repoPath);
			} catch {
				// Ignore - credential helper is optional
			}
			// Update remote URL to use token if available (for future fetches)
			if (cloneUrl !== url) {
				try {
					await this.runGit(['-C', repoPath, 'remote', 'set-url', 'origin', cloneUrl], repoPath);
					console.log('[GitHubService] Remote origin updated with authenticated URL');
				} catch {
					// Ignore
				}
			}
			// Fetch all remote refs after clone to ensure all branches are available
			onProgress?.({stage: 'Fetching all branches'});
			await this.runGit(['-C', repoPath, 'fetch', '--all', '--prune'], repoPath);
			this.clearFileListCache();
		} else if (fetch) {
			onProgress?.({stage: 'Fetching updates'});
			await this.runGitWithProgress(['-C', repoPath, 'fetch', '--all', '--prune', '--progress'], repoPath, onProgress);
			this.clearFileListCache();
		}

		this.lastLocalSyncIso = new Date().toISOString();
		return {repoPath};
	}

	private shouldFetchWorktree(branch: string, fetchIntervalMs: number): boolean {
		const lastSync = this.worktreeLastSyncMs.get(branch);
		if (!lastSync) {
			return true;
		}
		return Date.now() - lastSync >= fetchIntervalMs;
	}

	async ensureWorktree(
		branch: string,
		url: string,
		options?: { fetch?: boolean; fetchIntervalMs?: number },
	): Promise<{ worktreePath: string }> {
		const fetch           = options?.fetch ?? false;
		const fetchIntervalMs = options?.fetchIntervalMs ?? this.worktreeFetchIntervalMs;
		await this.ensureLocalRepo(url, {fetch});
		const worktreesRoot = this.getWorktreesRoot();
		await fs.mkdir(worktreesRoot, {recursive: true});

		const safeBranch   = branch.replace(/[^a-zA-Z0-9._-]/g, '_');
		const worktreePath = path.join(worktreesRoot, safeBranch);

		// Always prune stale worktrees first to avoid "already used by worktree" errors
		// This cleans up entries where the directory was deleted but Git still tracks them
		try {
			await this.runGit(['-C', this.getLocalRepoRoot(), 'worktree', 'prune'], this.getLocalRepoRoot());
		} catch {
			// Ignore prune errors - not critical
		}

		if (!(await this.pathExists(worktreePath))) {
			// Check if branch exists in remote refs
			const {exitCode} = await this.runGitWithExitCodes(
				['-C', this.getLocalRepoRoot(), 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
				this.getLocalRepoRoot(),
				[0, 1],
			);

			if (exitCode === 1) {
				// Branch not found locally - fetch ALL remote refs first
				// This is needed because initial clone may not have fetched all branches
				console.log(`[GitHubService] Branch '${branch}' not found locally, fetching all remote refs...`);
				try {
					await this.runGit(['-C', this.getLocalRepoRoot(), 'fetch', '--all', '--prune'], this.getLocalRepoRoot());
				} catch (fetchAllError) {
					// If fetch --all fails, try fetching the specific branch
					console.log(`[GitHubService] Fetch --all failed, trying specific branch: ${branch}`);
					await this.runGit(['-C', this.getLocalRepoRoot(), 'fetch', 'origin', branch], this.getLocalRepoRoot());
				}

				// Verify branch now exists
				const {exitCode: verifyExitCode} = await this.runGitWithExitCodes(
					['-C', this.getLocalRepoRoot(), 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
					this.getLocalRepoRoot(),
					[0, 1],
				);
				if (verifyExitCode === 1) {
					throw new Error(`Branch '${branch}' does not exist in remote repository. Please check the branch name.`);
				}
			}

			// Create the worktree
			console.log(`[GitHubService] Creating worktree for branch '${branch}' at ${worktreePath}`);
			try {
				await this.runGit(
					['-C', this.getLocalRepoRoot(), 'worktree', 'add', '-B', branch, worktreePath, `origin/${branch}`],
					this.getLocalRepoRoot(),
				);
			} catch (worktreeAddError) {
				const errMsg = worktreeAddError instanceof Error ? worktreeAddError.message : String(worktreeAddError);
				// If worktree is "already used", force remove it and retry
				if (errMsg.includes('already used by worktree') || errMsg.includes('already checked out')) {
					console.log(`[GitHubService] Worktree conflict detected, force removing and retrying...`);
					try {
						await this.runGit(['-C', this.getLocalRepoRoot(), 'worktree', 'remove', '--force', worktreePath], this.getLocalRepoRoot());
					} catch {
						// If remove fails, try to delete the directory manually
						try {
							await fs.rm(worktreePath, {recursive: true, force: true});
						} catch {
							// Ignore
						}
					}
					// Prune again and retry
					await this.runGit(['-C', this.getLocalRepoRoot(), 'worktree', 'prune'], this.getLocalRepoRoot());
					await this.runGit(
						['-C', this.getLocalRepoRoot(), 'worktree', 'add', '-B', branch, worktreePath, `origin/${branch}`],
						this.getLocalRepoRoot(),
					);
				} else {
					throw worktreeAddError;
				}
			}
			this.worktreeLastSyncMs.set(branch, Date.now());
		} else {
			if (fetch && this.shouldFetchWorktree(branch, fetchIntervalMs)) {
				await this.runGit(['-C', worktreePath, 'fetch', 'origin', branch], worktreePath);
				await this.runGit(['-C', worktreePath, 'checkout', branch], worktreePath);
				await this.runGit(['-C', worktreePath, 'reset', '--hard', `origin/${branch}`], worktreePath);
				this.worktreeLastSyncMs.set(branch, Date.now());
			}
		}

		this.lastLocalSyncIso = new Date().toISOString();
		return {worktreePath};
	}

	private resolveWorktreeFile(worktreePath: string, filePath: string): string {
		const resolved       = path.resolve(worktreePath, filePath);
		const normalizedRoot = path.resolve(worktreePath) + path.sep;
		if (!resolved.startsWith(normalizedRoot)) {
			throw new Error('Invalid file path');
		}
		return resolved;
	}

	private parseSearchQuery(query: string): { cleanedQuery: string; pathSpecs: string[] } {
		const raw = String(query || '').trim();
		if (!raw) {
			return {cleanedQuery: '', pathSpecs: []};
		}

		const pathSpecs: string[] = [];
		let cleanedQuery          = raw;
		const re                  = /\b(path|file):("([^"]+)"|[^\s]+)/gi;
		let m: RegExpExecArray | null;
		while ((m = re.exec(raw)) !== null) {
			const value = (m[3] || m[2] || '').replace(/^"+|"+$/g, '').trim();
			if (!value) {
				continue;
			}
			const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
			if (normalized.includes('..') || normalized.startsWith('-')) {
				continue;
			}
			pathSpecs.push(normalized);
		}

		cleanedQuery = cleanedQuery.replace(re, ' ');
		// Drop other GitHub code search operators that don't apply to ripgrep.
		cleanedQuery = cleanedQuery
			.replace(/\b(repo|language|org|user):[^\s]+/gi, ' ')
			.replace(/\s+/g, ' ')
			.trim();

		return {cleanedQuery, pathSpecs};
	}

	private inferPathSpecs(tokens: string[]): string[] {
		const t = new Set(tokens.map((x) => x.toLowerCase()));
		const specs: string[] = [];

		// SPY-specific module mappings for fast path-based filtering
		const moduleMap: Record<string, string[]> = {
			confident : ['applications/Spy/Controller/Confident', 'applications/Spy/Model/Confident', 'applications/Spy/View/Confident'],
			sales     : ['applications/Spy/Controller/Sales', 'applications/Spy/Model/Sales', 'applications/Spy/View/Sales'],
			purchase  : ['applications/Spy/Controller/Purchase', 'applications/Spy/Model/Purchase', 'applications/Spy/View/Purchase'],
			order     : ['applications/Spy/Controller/Order', 'applications/Spy/Model/Order', 'applications/Spy/View/Order', 'applications/Spy/Controller/Sales'],
			customer  : ['applications/Spy/Controller/Customer', 'applications/Spy/Model/Customer', 'applications/Spy/View/Customer'],
			product   : ['applications/Spy/Controller/Product', 'applications/Spy/Model/Product', 'applications/Spy/View/Product'],
			inventory : ['applications/Spy/Controller/Inventory', 'applications/Spy/Model/Inventory', 'applications/Spy/View/Inventory'],
			warehouse : ['applications/Spy/Controller/Warehouse', 'applications/Spy/Model/Warehouse', 'applications/Spy/View/Warehouse'],
			shipping  : ['applications/Spy/Controller/Shipping', 'applications/Spy/Model/Shipping', 'applications/Spy/View/Shipping'],
			invoice   : ['applications/Spy/Controller/Invoice', 'applications/Spy/Model/Invoice', 'applications/Spy/View/Invoice'],
			claim     : ['applications/Spy/Controller/Claim', 'applications/Spy/Model/Claim', 'applications/Spy/View/Claim'],
			return    : ['applications/Spy/Controller/Return', 'applications/Spy/Model/Return', 'applications/Spy/View/Return', 'applications/Spy/Controller/Claim'],
			season    : ['applications/Spy/Model/Season', 'applications/Spy/Controller/Season'],
			sæson     : ['applications/Spy/Model/Season', 'applications/Spy/Controller/Season'],
			topseller : ['applications/Spy/Controller/Confident', 'applications/Spy/Model/Confident'],
			edi       : ['applications/Spy/Controller/EDI', 'applications/Spy/Model/EDI', 'applications/Spy/View/EDI'],
			report    : ['applications/Spy/Controller/Report', 'applications/Spy/Model/Report', 'applications/Spy/View/Report'],
			api       : ['applications/Spy/Controller/Api', 'applications/Spy/Model/Api'],
			brand     : ['applications/Spy/Controller/Brand', 'applications/Spy/Model/Brand', 'applications/Spy/View/Brand'],
			supplier  : ['applications/Spy/Controller/Supplier', 'applications/Spy/Model/Supplier', 'applications/Spy/View/Supplier'],
			user      : ['applications/Spy/Controller/User', 'applications/Spy/Model/User', 'applications/Spy/View/User'],
			nemedi    : ['applications/Spy/Controller/NemEdi', 'applications/Spy/Model/NemEdi', 'applications/Spy/View/NemEdi', 'applications/Spy/Controller/EDI'],
		};

		for (const token of t) {
			const mapped = moduleMap[token];
			if (mapped) {
				specs.push(...mapped);
			}
		}

		// If tokens look like class/function names (PascalCase or camelCase), also search lib/packages
		for (const token of tokens) {
			if (/^[A-Z][a-zA-Z0-9]+$/.test(token)) {
				// PascalCase - likely a class name
				specs.push('packages', 'applications/Spy/Model', 'applications/Spy/Controller');
			}
		}

		return Array.from(new Set(specs));
	}

	private extractSearchTokens(cleanedQuery: string, maxTokens: number = 4): string[] {
		const raw = String(cleanedQuery || '').trim();
		if (!raw) {
			return [];
		}

		const stop = new Set([
			'repo',
			'language',
			'org',
			'user',
			'module',
			'component',
		]);

		return raw
			.toLowerCase()
			.split(/[^a-z0-9_]+/g)
			.map((t) => t.trim())
			.filter((t) => t.length >= 3 && !stop.has(t))
			.slice(0, maxTokens);
	}


	/**
	 * Run ripgrep (rg) with the given arguments.
	 * Returns stdout and exit code. Exit code 1 means no matches (not an error).
	 */
	private async runRipgrep(
		args: string[],
		cwd: string,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const rg = await getRipgrepPath();
		return await new Promise((resolve, reject) => {
			const child = spawn(rg, args, {cwd, windowsHide: true});
			let stdout  = '';
			let stderr  = '';

			child.stdout?.on('data', (chunk) => {
				stdout += chunk.toString();
			});

			child.stderr?.on('data', (chunk) => {
				stderr += chunk.toString();
			});

			child.on('error', (error: NodeJS.ErrnoException) => {
				// Handle ripgrep binary not found
				if (error.code === 'ENOENT') {
					reject(new Error(`Ripgrep binary not found at: ${rg}. Please reinstall the application.`));
				} else {
					reject(error);
				}
			});

			child.on('close', (code) => {
				const exitCode = typeof code === 'number' ? code : 1;
				// rg exits with 0 = matches found, 1 = no matches, 2 = error
				if (exitCode <= 1) {
					resolve({stdout: stdout.trim(), stderr: stderr.trim(), exitCode});
				} else {
					reject(new Error(stderr.trim() || `Ripgrep failed with code ${exitCode}`));
				}
			});
		});
	}

	async searchCodeLocal(query: string, branch: string, url: string): Promise<Array<{ path: string; matches: string[] }>> {
		const startTime = Date.now();

		// IMPORTANT: Don't fetch on every search - only ensure worktree exists
		const {worktreePath}            = await this.ensureWorktree(branch, url, {fetch: false});
		const {cleanedQuery, pathSpecs} = this.parseSearchQuery(query);
		const tokens                    = this.extractSearchTokens(cleanedQuery, 5);
		const inferredPathSpecs         = pathSpecs.length === 0 ? this.inferPathSpecs(tokens) : [];
		const allPathHints              = [...pathSpecs, ...inferredPathSpecs];

		// Build ripgrep arguments
		// rg is MUCH faster than git grep - no need for file pre-filtering
		const buildArgs = (searchDirs: string[]): string[] => {
			const args: string[] = [
				'--line-number',           // Show line numbers
				'--no-heading',            // file:line:match format
				'--color=never',           // No ANSI colors
				'--ignore-case',           // Case insensitive
				'--max-count=5',           // Max matches per file
				'--max-filesize=1M',       // Skip files >1MB
				'--type=php',              // Search PHP files
				'--type=ts',               // Search TypeScript files
				'--type=js',               // Search JavaScript files
				'--type=json',             // Search JSON files
				'--type=css',              // Search CSS files
				'--glob=!node_modules',    // Exclude node_modules
				'--glob=!vendor',          // Exclude vendor
				'--glob=!*.min.js',        // Exclude minified JS
				'--glob=!*.min.css',       // Exclude minified CSS
				'--glob=!*.map',           // Exclude source maps
			];

			// Build search pattern
			if (tokens.length > 0) {
				// Use regex alternation for fast multi-token search
				args.push('-e', tokens.join('|'));
			} else {
				// Fixed string search for exact query
				args.push('--fixed-strings', '-e', cleanedQuery || query);
			}

			// Add search directories (or current dir if none)
			if (searchDirs.length > 0) {
				args.push(...searchDirs);
			} else {
				args.push('.');
			}

			return args;
		};

		let stdout   = '';
		let exitCode = 1;

		// Strategy: Narrow -> Wide search using ripgrep
		// 1) Search with path hints first (if any)
		if (allPathHints.length > 0) {
			// Filter to paths that exist
			const existingPaths: string[] = [];
			for (const hint of allPathHints) {
				const fullPath = path.join(worktreePath, hint);
				if (await this.pathExists(fullPath)) {
					existingPaths.push(hint);
				}
			}

			if (existingPaths.length > 0) {
				this.lastLocalSearchMeta = {
					branch,
					worktreePath,
					tokens,
					mode: 'any',
					pathSpecs: existingPaths,
					durationMs: 0,
				};
				const args = buildArgs(existingPaths);
				({stdout, exitCode} = await this.runRipgrep(args, worktreePath));
			}
		}

		// 2) Global search as fallback
		if (exitCode === 1) {
			this.lastLocalSearchMeta = {
				branch,
				worktreePath,
				tokens,
				mode: 'any',
				pathSpecs: ['(global)'],
				durationMs: 0,
			};
			const args = buildArgs([]);
			({stdout, exitCode} = await this.runRipgrep(args, worktreePath));
		}

		const durationMs = Date.now() - startTime;
		if (this.lastLocalSearchMeta) {
			this.lastLocalSearchMeta.durationMs = durationMs;
		}

		if (exitCode === 1 || !stdout) {
			return [];
		}

		// Parse ripgrep results (format: file:line:match)
		const lines  = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
		const byFile = new Map<string, string[]>();
		for (const line of lines) {
			const firstColon  = line.indexOf(':');
			const secondColon = line.indexOf(':', firstColon + 1);
			if (firstColon === -1 || secondColon === -1) {
				continue;
			}
			const file     = line.slice(0, firstColon);
			const lineNo   = line.slice(firstColon + 1, secondColon).trim();
			const fragment = line.slice(secondColon + 1).trim();
			if (!file) {
				continue;
			}
			if (!byFile.has(file)) {
				byFile.set(file, []);
			}
			if (fragment) {
				const arr = byFile.get(file)!;
				if (arr.length < 5) {
					arr.push(`${lineNo}: ${fragment}`);
				}
			}
		}

		// Score and rank results
		const scored = Array.from(byFile.entries()).map(([filePath, matches]) => {
			let score     = 0;
			const lowerFp = filePath.toLowerCase();

			for (const token of tokens) {
				if (!token) continue;
				const lt = token.toLowerCase();

				// Strong bonus for token in filename
				const fileName = filePath.split('/').pop()?.toLowerCase() || '';
				if (fileName.includes(lt)) {
					score += 10;
				} else if (lowerFp.includes(lt)) {
					score += 3;
				}

				// Bonus for matches containing token
				for (const m of matches) {
					if (m.toLowerCase().includes(lt)) {
						score += 1;
					}
				}
			}

			// Prefer PHP/TypeScript source files
			if (/\.(php|ts|tsx)$/i.test(filePath)) {
				score += 2;
			}
			// Prefer controller/model/view
			if (/(controller|model|view|service)/i.test(filePath)) {
				score += 2;
			}
			// Slight preference for shorter paths (more focused)
			score -= Math.floor(filePath.split('/').length / 5);

			return {path: filePath, matches, score};
		});

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, 15).map(({path: p, matches}) => ({path: p, matches}));
	}

	getLastLocalSearchMeta(): null | { branch: string; worktreePath: string; tokens: string[]; mode: 'all' | 'any'; pathSpecs: string[]; durationMs: number } {
		return this.lastLocalSearchMeta;
	}

	async readFileLocal(filePath: string, branch: string, url: string): Promise<string> {
		// Don't fetch on every file read - worktree is kept updated by background sync
		const {worktreePath} = await this.ensureWorktree(branch, url, {fetch: false});
		const fullPath       = this.resolveWorktreeFile(worktreePath, filePath);
		return await fs.readFile(fullPath, 'utf-8');
	}

	async readFileLocalSnippet(filePath: string, branch: string, url: string, startLine: number, endLine: number): Promise<string> {
		const content = await this.readFileLocal(filePath, branch, url);
		const lines = content.split(/\r?\n/);
		const start = Math.max(1, Math.floor(startLine));
		const end = Math.max(start, Math.floor(endLine));
		const slice = lines.slice(start - 1, end);
		return slice
			.map((line, idx) => `${start + idx}|${line}`)
			.join('\n');
	}

	async listFilesLocal(directoryPath: string, branch: string, url: string): Promise<Array<{ path: string; type: 'file' | 'dir' }>> {
		// Don't fetch on every list - worktree is kept updated by background sync
		const {worktreePath} = await this.ensureWorktree(branch, url, {fetch: false});
		const fullPath       = this.resolveWorktreeFile(worktreePath, directoryPath || '.');
		if (!(await this.pathExists(fullPath))) {
			return [];
		}
		const entries = await fs.readdir(fullPath, {withFileTypes: true});
		return entries.map((entry) => ({
			path: directoryPath ? path.join(directoryPath, entry.name) : entry.name,
			type: entry.isDirectory() ? 'dir' : 'file',
		}));
	}

	async getTreeLocal(branch: string, url: string): Promise<Array<{ path: string; type: string }>> {
		// Don't fetch on every tree - worktree is kept updated by background sync
		const {worktreePath} = await this.ensureWorktree(branch, url, {fetch: false});
		const {stdout}       = await this.runGitWithExitCodes(
			['-C', worktreePath, 'ls-tree', '-r', '--name-only', 'HEAD'],
			worktreePath,
			[0],
		);
		return stdout
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
			.map((filePath) => ({path: filePath, type: 'file'}));
	}

	private getAuthorizationHeader(): string {
		if (!this.config) {
			throw new Error('GitHub not configured');
		}

		// Trim whitespace from token
		const token = this.config.token.trim();

		// Fine-grained tokens (github_pat_*) use Bearer, classic tokens (ghp_*) use token
		if (token.startsWith('github_pat_')) {
			return `Bearer ${token}`;
		}
		return `token ${token}`;
	}

	private getBranchOrDefault(branchOverride?: string): string {
		const trimmed = branchOverride?.trim();
		if (trimmed) {
			return trimmed;
		}
		if (this.config?.branch) {
			return this.config.branch;
		}
		return 'main';
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

			const headers = {
				'Authorization'       : authHeader,
				'Accept'              : 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent'          : 'Sporge-Jorgen-App',
			};

			const response = await fetch('https://api.github.com/user', {
				headers: headers,
			});

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

	async searchCode(query: string, branchOverride?: string): Promise<Array<{ path: string; matches: string[] }>> {
		const localRepoUrl = this.localRepoUrl;
		const branch       = this.getBranchOrDefault(branchOverride);
		if (localRepoUrl) {
			try {
				return await this.searchCodeLocal(query, branch, localRepoUrl);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Local repository search failed: ${message}`);
			}
		}

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

	async getFileContent(filePath: string, _githubBranchOverride: string | undefined, branchOverride?: string): Promise<string> {
		const localRepoUrl = this.localRepoUrl;
		const branch       = this.getBranchOrDefault(branchOverride ?? _githubBranchOverride);
		if (localRepoUrl) {
			try {
				return await this.readFileLocal(filePath, branch, localRepoUrl);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Local repository file read failed: ${message}`);
			}
		}

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
				`/repos/${this.config.owner}/${this.config.repo}/contents/${encodedPath}?ref=${branch}`,
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

	async listFiles(directoryPath: string = '', branchOverride?: string): Promise<Array<{ path: string; type: 'file' | 'dir' }>> {
		const localRepoUrl = this.localRepoUrl;
		const branch       = this.getBranchOrDefault(branchOverride);
		if (localRepoUrl) {
			try {
				return await this.listFilesLocal(directoryPath, branch, localRepoUrl);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Local repository list files failed: ${message}`);
			}
		}

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
				`/repos/${this.config.owner}/${this.config.repo}/contents/${encodedPath}?ref=${branch}`,
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

	async getTree(recursive: boolean = false, branchOverride?: string): Promise<Array<{ path: string; type: string }>> {
		const localRepoUrl = this.localRepoUrl;
		const branch       = this.getBranchOrDefault(branchOverride);
		if (localRepoUrl) {
			try {
				return await this.getTreeLocal(branch, localRepoUrl);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Local repository tree fetch failed: ${message}`);
			}
		}

		if (!this.config) {
			const config = await this.getConfig();
			if (!config) {
				throw new Error('GitHub not configured');
			}
			this.config = config;
		}

		try {
			const branch     = this.getBranchOrDefault(branchOverride);
			// Get the latest commit SHA for the branch
			const branchData = await this.githubRequest(
				`/repos/${this.config.owner}/${this.config.repo}/branches/${branch}`,
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
