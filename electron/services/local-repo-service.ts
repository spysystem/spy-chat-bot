import {spawn} from 'child_process';
import {createHash} from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

interface RepoProgress {
	stage: string;
	percent?: number;
	message?: string;
}

export type RepoProgressFn = (progress: RepoProgress) => void;

interface WorktreeInfo {
	branch: string;
	path: string;
	commit?: string;
	lastUsedIso: string;
	lastSyncIso: string;
}

export interface LocalRepoStatus {
	exists: boolean;
	repoPath: string;
	url?: string;
	defaultBranch?: string;
	lastFetchIso?: string;
	worktrees: WorktreeInfo[];
}

export interface CodeSearchOptions {
	pattern: string;
	regex?: boolean;
	caseSensitive?: boolean;
	path?: string;
	glob?: string;
	contextLines?: number;
	maxMatches?: number;
}

interface CodeSearchFileResult {
	path: string;
	lines: Array<{ line: number; text: string; isMatch: boolean }>;
}

export interface CodeSearchResult {
	files: CodeSearchFileResult[];
	matchCount: number;
	truncated: boolean;
}

export interface CommitSummary {
	sha: string;
	date: string;
	author: string;
	subject: string;
	firstRelease?: string;
}

interface WorktreeState {
	dir: string;
	lastUsedIso: string;
	lastSyncIso: string;
}

interface RepoState {
	url: string;
	lastFetchIso?: string;
	worktrees: Record<string, WorktreeState>;
}

interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

const FETCH_TTL_MS           = 5 * 60 * 1000;
const WORKTREE_VERIFY_TTL_MS = 30 * 1000;
const WORKTREE_MAX_IDLE_DAYS = 21;
const MAX_SEARCH_LINE_LENGTH = 400;
const SEARCH_EXCLUDE_GLOBS   = [
	'!.git',
	'!node_modules',
	'!vendor',
	'!dist',
	'!build',
	'!*.min.js',
	'!*.min.css',
	'!*.map',
	'!*.lock',
	'!package-lock.json',
	'!*.png',
	'!*.jpg',
	'!*.gif',
	'!*.svg',
	'!*.woff*',
	'!*.ttf',
	'!*.pdf',
	'!*.zip',
];

/**
 * Credentials never belong in the URL we store or compare: strip them and normalise
 * the forms GitHub accepts for the same repository (.git suffix, trailing slash, host case).
 */
function cleanRepoUrl(url: string): string {
	const trimmed = url.trim();
	try {
		const parsed    = new URL(trimmed);
		parsed.username = '';
		parsed.password = '';
		return parsed.toString().replace(/\/+$/, '');
	} catch {
		return trimmed.replace(/\/+$/, '');
	}
}

function repoIdentity(url: string): string {
	const clean = cleanRepoUrl(url);
	try {
		const parsed = new URL(clean);
		return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\.git$/i, '').toLowerCase()}`;
	} catch {
		return clean.replace(/\.git$/i, '').toLowerCase();
	}
}

function isGitHubHttpsUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'github.com';
	} catch {
		return false;
	}
}

function worktreeDirName(branch: string): string {
	const safe = branch.replace(/[^a-zA-Z0-9._-]/g, '_');
	if (safe === branch) {
		return safe;
	}
	const hash = createHash('sha1').update(branch).digest('hex').slice(0, 8);
	return `${safe}-${hash}`;
}

// Windows (antivirus, indexer) can hold handles on a freshly written tree for a moment.
async function renameWithRetry(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
	}
}

/** Guards values placed in git options against being read as extra flags. */
function assertSafeArg(value: string, label: string): string {
	if (value.startsWith('-') || !/^[\w./ :-]+$/.test(value)) {
		throw new Error(`Invalid ${label}: ${value}`);
	}
	return value;
}

function cleanPathArg(value: string): string {
	const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '').trim();
	if (normalized === '' || normalized.split('/').includes('..')) {
		throw new Error(`Invalid path: ${value}`);
	}
	return normalized;
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * Owns the local clone used for code search: one partial clone plus one detached
 * worktree per branch. All git mutations are serialised through a single lock because
 * the model issues tool calls in parallel and git's index/worktree locks are not
 * designed for concurrent writers.
 */
export class LocalRepoService {
	private readonly repoPath: string;
	private readonly worktreesRoot: string;
	private readonly statePath: string;
	private readonly rgPathProvider: () => Promise<string>;
	private readonly getToken: () => Promise<string | null>;
	private state: RepoState | null = null;
	private lock: Promise<unknown>  = Promise.resolve();
	private readonly verifiedAt     = new Map<string, { ms: number; path: string; branch: string; commit: string }>();
	private readonly fileListCache  = new Map<string, string[]>();

	constructor(options: {
		rootDir: string;
		getToken: () => Promise<string | null>;
		getRipgrepPath: () => Promise<string>;
	}) {
		this.repoPath       = path.join(options.rootDir, 'spy');
		this.worktreesRoot  = path.join(options.rootDir, 'spy-worktrees');
		this.statePath      = path.join(options.rootDir, 'spy-state.json');
		this.getToken       = options.getToken;
		this.rgPathProvider = options.getRipgrepPath;
	}

	// ── Public API ───────────────────────────────────────────────────────────

	async getStatus(url: string | null): Promise<LocalRepoStatus> {
		const exists = await this.isValidRepo();
		if (!exists) {
			return {exists: false, repoPath: this.repoPath, url: url ?? undefined, worktrees: []};
		}
		const state                     = await this.loadState(url ?? '');
		const defaultBranch             = await this.getDefaultBranch().catch(() => undefined);
		const worktrees: WorktreeInfo[] = [];
		for (const [branch, entry] of Object.entries(state.worktrees)) {
			const commit = await this.gitOk(['rev-parse', '--short', 'HEAD'], entry.dir);
			worktrees.push({
				branch,
				path       : entry.dir,
				commit     : commit ?? undefined,
				lastUsedIso: entry.lastUsedIso,
				lastSyncIso: entry.lastSyncIso,
			});
		}
		worktrees.sort((a, b) => b.lastUsedIso.localeCompare(a.lastUsedIso));
		return {
			exists      : true,
			repoPath    : this.repoPath,
			url         : state.url || url || undefined,
			defaultBranch,
			lastFetchIso: state.lastFetchIso,
			worktrees,
		};
	}

	/**
	 * Full sync: clone if needed, fetch every branch, move every worktree to its
	 * branch's latest commit and drop worktrees that have not been used for a while.
	 */
	async sync(url: string, onProgress?: RepoProgressFn): Promise<LocalRepoStatus> {
		await this.withLock(async () => {
			const cloned = await this.ensureRepoUnlocked(url, {onProgress, fetch: 'never'});
			if (!cloned) {
				await this.fetchUnlocked(onProgress);
			}
			await this.runGit(['remote', 'set-head', 'origin', '--auto'], {cwd: this.repoPath, allowFail: true});
			await this.refreshAllWorktreesUnlocked(onProgress);
			await this.pruneWorktreesUnlocked();
		});
		onProgress?.({stage: 'Done', percent: 100});
		return await this.getStatus(url);
	}

	async listBranches(url: string): Promise<string[]> {
		await this.withLock(() => this.ensureRepoUnlocked(url, {fetch: 'if-stale'}));
		const out = await this.runGit(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'], {cwd: this.repoPath});
		return out.stdout
			.split('\n')
			.map((line) => line.trim().replace(/^refs\/remotes\/origin\//, ''))
			.filter((name) => name !== '' && name !== 'HEAD')
			.sort((a, b) => a.localeCompare(b));
	}

	/**
	 * Returns a worktree checked out at the latest fetched commit of `branch`
	 * (or the remote's default branch when none is given).
	 */
	async ensureWorktree(url: string, branch?: string): Promise<{ path: string; branch: string; commit: string }> {
		const requested = branch?.trim() || '';
		const cached    = this.verifiedAt.get(requested);
		if (cached && Date.now() - cached.ms < WORKTREE_VERIFY_TTL_MS) {
			return {path: cached.path, branch: cached.branch, commit: cached.commit};
		}

		return await this.withLock(async () => {
			await this.ensureRepoUnlocked(url, {fetch: 'if-stale'});
			const effectiveBranch = requested || await this.getDefaultBranch();
			let commit            = await this.resolveRemoteBranch(effectiveBranch);
			if (!commit) {
				// A branch created after our last fetch - fetch once more before giving up.
				await this.fetchUnlocked();
				commit = await this.resolveRemoteBranch(effectiveBranch);
			}
			if (!commit) {
				throw new Error(await this.describeMissingBranch(effectiveBranch));
			}

			const worktreePath = await this.checkoutWorktreeUnlocked(effectiveBranch, commit);
			const verified     = {ms: Date.now(), path: worktreePath, branch: effectiveBranch, commit};
			this.verifiedAt.set(effectiveBranch, verified);
			this.verifiedAt.set(requested, verified);
			return {path: worktreePath, branch: effectiveBranch, commit};
		});
	}

	async readFile(url: string, branch: string | undefined, relativePath: string): Promise<string> {
		const worktree = await this.ensureWorktree(url, branch);
		const fullPath = await this.resolveInside(worktree.path, relativePath);
		return await fs.readFile(fullPath, 'utf-8');
	}

	async listDirectory(url: string, branch: string | undefined, relativePath: string): Promise<Array<{ path: string; type: 'file' | 'dir' }>> {
		const worktree = await this.ensureWorktree(url, branch);
		const fullPath = await this.resolveInside(worktree.path, relativePath || '.');
		const entries  = await fs.readdir(fullPath, {withFileTypes: true});
		const base     = (relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		return entries
			.filter((entry) => entry.name !== '.git')
			.map((entry) => ({
				path: base ? `${base}/${entry.name}` : entry.name,
				type: entry.isDirectory() ? 'dir' as const : 'file' as const,
			}))
			.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
	}

	/** Finds tracked file paths containing every whitespace-separated term (case-insensitive). */
	async findFiles(url: string, branch: string | undefined, query: string, limit: number): Promise<{ paths: string[]; total: number }> {
		const worktree = await this.ensureWorktree(url, branch);
		let files      = this.fileListCache.get(worktree.commit);
		if (!files) {
			const out = await this.runGit(['ls-files'], {cwd: worktree.path});
			files     = out.stdout.split('\n').filter(Boolean);
			this.fileListCache.clear();
			this.fileListCache.set(worktree.commit, files);
		}
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		const hits  = files.filter((file) => {
			const lower = file.toLowerCase();
			return terms.every((term) => lower.includes(term));
		});
		return {paths: hits.slice(0, limit), total: hits.length};
	}

	async search(url: string, branch: string | undefined, options: CodeSearchOptions): Promise<CodeSearchResult> {
		const worktree   = await this.ensureWorktree(url, branch);
		const maxMatches = Math.max(1, Math.min(options.maxMatches ?? 60, 300));
		const context    = Math.max(0, Math.min(options.contextLines ?? 0, 30));
		const args       = [
			'--json',
			'--max-filesize=1M',
			'--max-count=20',
			...(options.caseSensitive ? ['--case-sensitive'] : ['--smart-case']),
			...(options.regex ? [] : ['--fixed-strings']),
			...(context > 0 ? [`--context=${context}`] : []),
			...SEARCH_EXCLUDE_GLOBS.map((glob) => `--glob=${glob}`),
			...(options.glob ? [`--glob=${options.glob}`] : []),
			'-e',
			options.pattern,
			'--',
		];
		if (options.path && options.path.trim() !== '') {
			const scoped = await this.resolveInside(worktree.path, options.path);
			args.push(path.relative(worktree.path, scoped) || '.');
		} else {
			args.push('.');
		}
		return await this.runRipgrepJson(args, worktree.path, maxMatches);
	}

	// ── History (read-only, no worktree needed) ──────────────────────────────

	/**
	 * Commits that touched `path` on a branch, newest first. With `search`, only commits that
	 * added or removed that text in `path` (git's pickaxe). Each commit is annotated with the
	 * first release branch (YYYY_MM) that contains it.
	 */
	async fileHistory(url: string, options: {
		branch?: string;
		path: string;
		search?: string;
		since?: string;
		limit?: number
	}): Promise<CommitSummary[]> {
		const ref   = await this.prepareHistory(url, options.branch);
		const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
		const args  = ['log', `--max-count=${limit}`, '--date=short', '--format=%h%x09%ad%x09%an%x09%s', '--no-merges'];
		if (options.search) {
			args.push(`-S${options.search}`);
		}
		if (options.since) {
			args.push(`--since=${assertSafeArg(options.since, 'since')}`);
		}
		args.push(ref, '--', cleanPathArg(options.path));
		const state                    = await this.loadState('');
		// Pickaxe reads old file versions, which a partial clone downloads on demand.
		const out                      = await this.runGit(args, {cwd: this.repoPath, network: true, url: state.url, timeoutMs: 120_000});
		const commits: CommitSummary[] = out.stdout.split('\n').filter(Boolean).map((line) => {
			const [sha, date, author, ...subject] = line.split('\t');
			return {sha, date, author, subject: subject.join('\t')};
		});
		for (const commit of commits) {
			commit.firstRelease = await this.firstReleaseContaining(commit.sha);
		}
		return commits;
	}

	/** Commit message, changed files and the diff (optionally limited to one path). */
	async showCommit(url: string, options: { commit: string; path?: string }): Promise<string> {
		await this.prepareHistory(url);
		if (!/^[0-9a-f]{4,40}$/i.test(options.commit)) {
			throw new Error('commit must be a commit hash');
		}
		const state = await this.loadState('');
		const args  = ['show', '--date=short', '--format=commit %H%nAuthor: %an%nDate: %ad%n%n%B', '--stat=160', '--patch', options.commit];
		if (options.path) {
			args.push('--', cleanPathArg(options.path));
		}
		const out     = await this.runGit(args, {cwd: this.repoPath, network: true, url: state.url, timeoutMs: 60_000});
		const release = await this.firstReleaseContaining(options.commit);
		return `${out.stdout.trim()}\n\nFirst release containing this commit: ${release ?? 'none yet'}`;
	}

	/** Commits on `to` that are not on `from` (e.g. what changed between two releases), plus a diff when a path is given. */
	async compareBranches(url: string, options: { from: string; to: string; path?: string; includeDiff?: boolean }): Promise<{
		commits: CommitSummary[];
		totalCommits: number;
		diff?: string
	}> {
		const fromRef = await this.prepareHistory(url, options.from);
		const toRef   = await this.historyRef(options.to);
		const state   = await this.loadState('');
		const range   = `${fromRef}..${toRef}`;
		const paths   = options.path ? ['--', cleanPathArg(options.path)] : [];
		const count   = await this.runGit(['rev-list', '--count', '--no-merges', range, ...paths], {cwd: this.repoPath});
		const log     = await this.runGit(['log', '--max-count=100', '--no-merges', '--date=short', '--format=%h%x09%ad%x09%an%x09%s', range, ...paths], {cwd: this.repoPath});
		const commits = log.stdout.split('\n').filter(Boolean).map((line) => {
			const [sha, date, author, ...subject] = line.split('\t');
			return {sha, date, author, subject: subject.join('\t')};
		});
		let diff: string | undefined;
		if (options.includeDiff && options.path) {
			const out = await this.runGit(['diff', '--stat=160', '--patch', `${fromRef}...${toRef}`, ...paths], {
				cwd      : this.repoPath,
				network  : true,
				url      : state.url,
				timeoutMs: 60_000,
			});
			diff      = out.stdout;
		}
		return {commits, totalCommits: Number(count.stdout.trim()) || commits.length, diff};
	}

	private async prepareHistory(url: string, branch?: string): Promise<string> {
		await this.withLock(() => this.ensureRepoUnlocked(url, {fetch: 'if-stale'}));
		return await this.historyRef(branch);
	}

	private async historyRef(branch?: string): Promise<string> {
		const name = branch?.trim() || await this.getDefaultBranch();
		assertSafeArg(name, 'branch');
		if (!(await this.resolveRemoteBranch(name))) {
			throw new Error(await this.describeMissingBranch(name));
		}
		return `refs/remotes/origin/${name}`;
	}

	private async firstReleaseContaining(sha: string): Promise<string | undefined> {
		const out = await this.runGit(
			['for-each-ref', `--contains=${sha}`, '--format=%(refname:short)', 'refs/remotes/origin/[0-9][0-9][0-9][0-9]_[0-9][0-9]'],
			{cwd: this.repoPath, allowFail: true},
		);
		return out.stdout.split('\n').map((l) => l.trim().replace(/^origin\//, '')).filter(Boolean).sort()[0];
	}

	// ── Repo lifecycle (callers must hold the lock) ─────────────────────────

	/** Returns true when a fresh clone was made. */
	private async ensureRepoUnlocked(
		url: string,
		options: { fetch: 'never' | 'if-stale'; onProgress?: RepoProgressFn },
	): Promise<boolean> {
		const cleanUrl = cleanRepoUrl(url);
		if (!cleanUrl) {
			throw new Error('Repository URL is not configured. Set it in Settings → Local Git Sync.');
		}

		if (await this.isValidRepo()) {
			const origin = await this.gitOk(['remote', 'get-url', 'origin'], this.repoPath);
			if (origin && repoIdentity(origin) === repoIdentity(cleanUrl)) {
				if (origin !== cleanUrl) {
					// Older versions embedded the token in the remote URL; replace it with the clean one.
					await this.runGit(['remote', 'set-url', 'origin', cleanUrl], {cwd: this.repoPath});
				}
				const state = await this.loadState(cleanUrl);
				if (state.url !== cleanUrl) {
					state.url = cleanUrl;
					await this.saveState();
				}
				if (options.fetch === 'if-stale' && this.isFetchStale(state)) {
					await this.fetchUnlocked(options.onProgress);
				}
				return false;
			}
			options.onProgress?.({stage: 'Repository URL changed - removing old clone'});
		}

		await this.cloneUnlocked(cleanUrl, options.onProgress);
		return true;
	}

	private async cloneUnlocked(cleanUrl: string, onProgress?: RepoProgressFn): Promise<void> {
		await fs.mkdir(path.dirname(this.repoPath), {recursive: true});
		await this.removeDir(this.worktreesRoot);
		await this.removeDir(this.repoPath);
		this.verifiedAt.clear();
		this.fileListCache.clear();

		// Clone next to the final location and rename on success, so an interrupted clone
		// never leaves a half-populated repository that later looks valid.
		const tempPath = `${this.repoPath}.tmp-${Date.now()}`;
		onProgress?.({stage: 'Cloning repository'});
		try {
			await this.runGit(
				['clone', '--progress', '--filter=blob:none', '--no-checkout', cleanUrl, tempPath],
				{cwd: path.dirname(this.repoPath), onProgress, network: true, url: cleanUrl},
			);
			await renameWithRetry(tempPath, this.repoPath);
		} catch (error) {
			await this.removeDir(tempPath);
			throw error;
		}

		this.state = {url: cleanUrl, lastFetchIso: new Date().toISOString(), worktrees: {}};
		await this.saveState();
	}

	private async fetchUnlocked(onProgress?: RepoProgressFn): Promise<void> {
		const state = await this.loadState('');
		onProgress?.({stage: 'Fetching branches'});
		await this.runGit(['fetch', '--prune', '--progress', 'origin'], {cwd: this.repoPath, onProgress, network: true, url: state.url});
		state.lastFetchIso = new Date().toISOString();
		this.verifiedAt.clear();
		await this.saveState();
	}

	private async checkoutWorktreeUnlocked(branch: string, commit: string): Promise<string> {
		const state   = await this.loadState('');
		const now     = new Date().toISOString();
		const entry   = state.worktrees[branch];
		const dir     = entry?.dir ?? path.join(this.worktreesRoot, worktreeDirName(branch));
		const isValid = await this.isValidWorktree(dir);

		if (!isValid) {
			await this.removeDir(dir);
			await this.runGit(['worktree', 'prune'], {cwd: this.repoPath, allowFail: true});
			await fs.mkdir(this.worktreesRoot, {recursive: true});
			// Detached worktrees avoid "branch is already checked out" conflicts entirely.
			await this.runGit(['worktree', 'add', '--detach', '--force', dir, commit], {cwd: this.repoPath, network: true, url: state.url});
			state.worktrees[branch] = {dir, lastUsedIso: now, lastSyncIso: now};
		} else {
			const head = await this.gitOk(['rev-parse', 'HEAD'], dir);
			if (head !== commit) {
				await this.runGit(['checkout', '--detach', '--force', commit], {cwd: dir, network: true, url: state.url});
				state.worktrees[branch] = {dir, lastUsedIso: now, lastSyncIso: now};
			} else {
				state.worktrees[branch] = {dir, lastUsedIso: now, lastSyncIso: entry?.lastSyncIso ?? now};
			}
		}
		await this.saveState();
		return dir;
	}

	private async refreshAllWorktreesUnlocked(onProgress?: RepoProgressFn): Promise<void> {
		const state    = await this.loadState('');
		const branches = Object.keys(state.worktrees);
		let done       = 0;
		for (const branch of branches) {
			onProgress?.({
				stage  : `Updating branch ${branch}`,
				percent: branches.length > 0 ? Math.round((done / branches.length) * 100) : undefined,
			});
			const commit = await this.resolveRemoteBranch(branch);
			if (!commit) {
				// Branch was deleted upstream.
				await this.removeWorktreeUnlocked(branch);
			} else {
				await this.checkoutWorktreeUnlocked(branch, commit);
				this.verifiedAt.set(branch, {ms: Date.now(), path: state.worktrees[branch].dir, branch, commit});
			}
			done++;
		}
	}

	private async pruneWorktreesUnlocked(): Promise<void> {
		const state  = await this.loadState('');
		const cutoff = Date.now() - WORKTREE_MAX_IDLE_DAYS * 24 * 60 * 60 * 1000;
		for (const [branch, entry] of Object.entries(state.worktrees)) {
			if (Date.parse(entry.lastUsedIso) < cutoff) {
				await this.removeWorktreeUnlocked(branch);
			}
		}

		// Directories we no longer track (for example left behind by older versions).
		const known = new Set(Object.values(state.worktrees).map((entry) => path.resolve(entry.dir)));
		if (await pathExists(this.worktreesRoot)) {
			for (const name of await fs.readdir(this.worktreesRoot)) {
				const dir = path.resolve(this.worktreesRoot, name);
				if (!known.has(dir)) {
					await this.removeDir(dir);
				}
			}
		}
		await this.runGit(['worktree', 'prune'], {cwd: this.repoPath, allowFail: true});
	}

	private async removeWorktreeUnlocked(branch: string): Promise<void> {
		const state = await this.loadState('');
		const entry = state.worktrees[branch];
		if (!entry) {
			return;
		}
		await this.runGit(['worktree', 'remove', '--force', entry.dir], {cwd: this.repoPath, allowFail: true});
		await this.removeDir(entry.dir);
		delete state.worktrees[branch];
		this.verifiedAt.delete(branch);
		await this.saveState();
	}

	// ── State ────────────────────────────────────────────────────────────────

	private async loadState(fallbackUrl: string): Promise<RepoState> {
		if (this.state) {
			return this.state;
		}
		try {
			const raw  = JSON.parse(await fs.readFile(this.statePath, 'utf-8')) as Partial<RepoState>;
			this.state = {url: raw.url || fallbackUrl, lastFetchIso: raw.lastFetchIso, worktrees: raw.worktrees || {}};
		} catch {
			this.state = {url: fallbackUrl, worktrees: await this.adoptLegacyWorktrees()};
			await this.saveState();
		}
		return this.state;
	}

	private async saveState(): Promise<void> {
		if (!this.state) {
			return;
		}
		await fs.mkdir(path.dirname(this.statePath), {recursive: true});
		await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
	}

	/** Earlier versions kept one worktree per local branch without a state file - keep using them. */
	private async adoptLegacyWorktrees(): Promise<Record<string, WorktreeState>> {
		const adopted: Record<string, WorktreeState> = {};
		if (!(await this.isValidRepo())) {
			return adopted;
		}
		const out                     = await this.runGit(['worktree', 'list', '--porcelain'], {cwd: this.repoPath, allowFail: true});
		const now                     = new Date().toISOString();
		const root                    = path.resolve(this.worktreesRoot);
		let currentDir: string | null = null;
		for (const line of out.stdout.split('\n')) {
			if (line.startsWith('worktree ')) {
				currentDir = path.resolve(line.slice('worktree '.length).trim());
			} else if (line.startsWith('branch ') && currentDir && currentDir.startsWith(root + path.sep)) {
				const branch    = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
				adopted[branch] = {dir: currentDir, lastUsedIso: now, lastSyncIso: now};
			} else if (line.trim() === '') {
				currentDir = null;
			}
		}
		return adopted;
	}

	private isFetchStale(state: RepoState): boolean {
		return !state.lastFetchIso || Date.now() - Date.parse(state.lastFetchIso) > FETCH_TTL_MS;
	}

	// ── Git helpers ──────────────────────────────────────────────────────────

	private async withLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.lock.then(fn, fn);
		this.lock = run.catch(() => undefined);
		return await run;
	}

	private async isValidRepo(): Promise<boolean> {
		if (!(await pathExists(path.join(this.repoPath, '.git')))) {
			return false;
		}
		const refs = await this.gitOk(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/origin'], this.repoPath);
		return !!refs;
	}

	private async isValidWorktree(dir: string): Promise<boolean> {
		if (!(await pathExists(path.join(dir, '.git')))) {
			return false;
		}
		return !!(await this.gitOk(['rev-parse', '--verify', '--quiet', 'HEAD'], dir));
	}

	private async resolveRemoteBranch(branch: string): Promise<string | null> {
		return await this.gitOk(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], this.repoPath);
	}

	private async getDefaultBranch(): Promise<string> {
		const head = await this.gitOk(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], this.repoPath);
		if (head) {
			return head.replace(/^origin\//, '');
		}
		for (const candidate of ['main', 'master']) {
			if (await this.resolveRemoteBranch(candidate)) {
				return candidate;
			}
		}
		throw new Error('Could not determine the repository default branch. Select a branch for this chat.');
	}

	private async describeMissingBranch(branch: string): Promise<string> {
		const out     = await this.runGit(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'], {cwd: this.repoPath, allowFail: true});
		const needle  = branch.toLowerCase();
		const similar = out.stdout
			.split('\n')
			.map((line) => line.trim().replace(/^refs\/remotes\/origin\//, ''))
			.filter((name) => name && name !== 'HEAD' && (name.toLowerCase().includes(needle) || needle.includes(name.toLowerCase())))
			.slice(0, 5);
		return `Branch '${branch}' does not exist in the repository.${similar.length > 0 ? ` Similar branches: ${similar.join(', ')}` : ''}`;
	}

	private async resolveInside(root: string, relativePath: string): Promise<string> {
		const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
		const resolved   = path.resolve(root, normalized);
		const realRoot   = await fs.realpath(root);
		let realTarget: string;
		try {
			realTarget = await fs.realpath(resolved);
		} catch {
			throw new Error(`Path not found in repository: ${relativePath}`);
		}
		if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
			throw new Error(`Path is outside the repository: ${relativePath}`);
		}
		if (realTarget.split(path.sep).includes('.git')) {
			throw new Error(`Path is not readable: ${relativePath}`);
		}
		return realTarget;
	}

	private async removeDir(dir: string): Promise<void> {
		await fs.rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 200});
	}

	private async gitOk(args: string[], cwd: string): Promise<string | null> {
		const result = await this.runGit(args, {cwd, allowFail: true});
		return result.code === 0 ? result.stdout.trim() || null : null;
	}

	private async buildEnv(network: boolean, url?: string): Promise<NodeJS.ProcessEnv> {
		const env: NodeJS.ProcessEnv               = {
			...process.env,
			GIT_TERMINAL_PROMPT: '0',
			GCM_INTERACTIVE    : 'never',
			LC_ALL             : 'C',
		};
		const extraConfig: Array<[string, string]> = [['core.longpaths', 'true']];
		if (network && url && isGitHubHttpsUrl(url)) {
			const token = (await this.getToken())?.trim();
			if (token) {
				// Passed through the environment so the token never lands in .git/config or
				// the process list. x-access-token works for classic and fine-grained PATs.
				const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
				extraConfig.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basic}`]);
			}
		}
		env.GIT_CONFIG_COUNT = String(extraConfig.length);
		extraConfig.forEach(([key, value], index) => {
			env[`GIT_CONFIG_KEY_${index}`]   = key;
			env[`GIT_CONFIG_VALUE_${index}`] = value;
		});
		return env;
	}

	private async runGit(
		args: string[],
		options: { cwd: string; onProgress?: RepoProgressFn; allowFail?: boolean; network?: boolean; url?: string; timeoutMs?: number },
	): Promise<GitResult> {
		const env = await this.buildEnv(options.network ?? false, options.url);
		return await new Promise<GitResult>((resolve, reject) => {
			const child  = spawn('git', args, {cwd: options.cwd, env, windowsHide: true});
			let stdout   = '';
			let stderr   = '';
			let pending  = '';
			let timedOut = false;
			const timer  = options.timeoutMs
				? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, options.timeoutMs)
				: null;

			child.stdout.on('data', (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on('data', (chunk: Buffer) => {
				const text = chunk.toString();
				stderr += text;
				if (!options.onProgress) {
					return;
				}
				// git redraws progress lines with \r, so split on both.
				pending += text;
				const parts = pending.split(/[\r\n]/);
				pending     = parts.pop() ?? '';
				for (const part of parts) {
					reportGitProgress(part.trim(), options.onProgress);
				}
			});
			child.on('error', (error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') {
					reject(new Error('Git is not installed or not in PATH. Install Git from https://git-scm.com/downloads and restart the application.'));
				} else {
					reject(error);
				}
			});
			child.on('close', (code) => {
				if (timer) {
					clearTimeout(timer);
				}
				if (timedOut) {
					reject(new Error(`git ${args[0]} took longer than ${Math.round((options.timeoutMs ?? 0) / 1000)}s and was stopped. Narrow it down (a single file, a shorter period).`));
					return;
				}
				const exitCode = typeof code === 'number' ? code : 1;
				if (exitCode === 0 || options.allowFail) {
					resolve({stdout, stderr, code: exitCode});
					return;
				}
				reject(new Error(describeGitError(args, stderr)));
			});
		});
	}

	private async runRipgrepJson(args: string[], cwd: string, maxMatches: number): Promise<CodeSearchResult> {
		const rg = await this.rgPathProvider();
		return await new Promise<CodeSearchResult>((resolve, reject) => {
			const child    = spawn(rg, args, {cwd, windowsHide: true});
			const files    = new Map<string, CodeSearchFileResult>();
			let matchCount = 0;
			let truncated  = false;
			let buffer     = '';
			let stderr     = '';
			let stopped    = false;

			const handleLine = (line: string): void => {
				if (stopped || !line) {
					return;
				}
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type !== 'match' && event.type !== 'context') {
					return;
				}
				const filePath = String(event.data?.path?.text ?? '').replace(/^\.\//, '').replace(/\\/g, '/');
				const lineNo   = Number(event.data?.line_number ?? 0);
				let text       = String(event.data?.lines?.text ?? '').replace(/\r?\n$/, '');
				if (text.length > MAX_SEARCH_LINE_LENGTH) {
					text = `${text.slice(0, MAX_SEARCH_LINE_LENGTH)} …`;
				}
				if (!filePath || !lineNo) {
					return;
				}
				if (event.type === 'match') {
					if (matchCount >= maxMatches) {
						truncated = true;
						stopped   = true;
						child.kill();
						return;
					}
					matchCount++;
				}
				let file = files.get(filePath);
				if (!file) {
					file = {path: filePath, lines: []};
					files.set(filePath, file);
				}
				file.lines.push({line: lineNo, text, isMatch: event.type === 'match'});
			};

			child.stdout.on('data', (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split('\n');
				buffer      = lines.pop() ?? '';
				lines.forEach(handleLine);
			});
			child.stderr.on('data', (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on('error', (error: NodeJS.ErrnoException) => {
				reject(error.code === 'ENOENT' ? new Error(`Ripgrep binary not found at ${rg}. Reinstall the application.`) : error);
			});
			child.on('close', (code) => {
				handleLine(buffer.trim());
				// rg: 0 = matches, 1 = no matches, 2 = error (may still have partial results).
				if (!stopped && code === 2 && matchCount === 0) {
					reject(new Error(stderr.trim() || 'Code search failed'));
					return;
				}
				resolve({files: Array.from(files.values()), matchCount, truncated});
			});
		});
	}
}

function reportGitProgress(line: string, onProgress: RepoProgressFn): void {
	if (!line) {
		return;
	}
	const match = line.match(/^(?:remote:\s*)?(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Checking out files|Filtering content):\s+(\d+)%/i);
	if (match) {
		onProgress({stage: match[1], percent: Number(match[2]), message: line});
	}
}

function describeGitError(args: string[], stderr: string): string {
	const message = stderr
		.split(/[\r\n]/)
		.map((line) => line.trim())
		.filter((line) => line && !/^(remote: )?(Counting|Compressing|Receiving|Resolving|Enumerating|Updating files)/.test(line))
		.join('\n')
		.trim();
	if (/Authentication failed|could not read Username|terminal prompts disabled|403|401/i.test(message)) {
		return 'GitHub rejected the credentials. Check that the GitHub token in Settings is valid and has read access to the repository (classic: "repo" scope, fine-grained: "Contents: Read-only").';
	}
	if (/Repository not found/i.test(message)) {
		return 'Repository not found. Check the repository URL, and that the GitHub token has access to it.';
	}
	return `git ${args[0]} failed: ${message || 'unknown error'}`;
}
