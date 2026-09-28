import type {GitHubService} from '../github-service';
import {extractUiWorkflowTerms} from '../shared/intent-profile';

export function dedupeCodeSearchResults(results: Array<{ path: string; matches: string[] }>): Array<{ path: string; matches: string[] }> {
	const byPath = new Map<string, Set<string>>();
	for (const result of results) {
		if (!result?.path) {
			continue;
		}
		const existing = byPath.get(result.path) ?? new Set<string>();
		for (const match of result.matches || []) {
			const normalized = String(match || '').replace(/\s+/g, ' ').trim();
			if (normalized !== '') {
				existing.add(normalized);
			}
		}
		byPath.set(result.path, existing);
	}
	return Array.from(byPath.entries()).map(([path, matches]) => ({
		path,
		matches: Array.from(matches).slice(0, 6),
	}));
}

export function dedupeUiSearchResults(results: Array<{ path: string; matches: string[] }>, text: string): Array<{
	path: string;
	matches: string[];
	score: number
}> {
	const deduped       = dedupeCodeSearchResults(results);
	const workflowTerms = extractUiWorkflowTerms(text);
	return deduped
		.map(({path, matches}) => ({
			path,
			matches,
			score: scoreUiSearchResult(path, matches, workflowTerms),
		}))
		.sort((a, b) => b.score - a.score);
}

export async function enrichUiSearchResultsWithContext(
	results: Array<{ path: string; matches: string[]; score?: number }>,
	ctx: { githubService: GitHubService; branch: string; localRepoUrl: string | null },
): Promise<Array<{ path: string; matches: string[]; excerpt?: string; score?: number }>> {
	const localRepoUrl = ctx.localRepoUrl;
	if (!localRepoUrl) {
		return results.slice(0, 8);
	}
	const enriched = await Promise.all(results.slice(0, 6).map(async (result) => {
		try {
			const firstMatch = (result.matches && result.matches.length > 0) ? String(result.matches[0]) : '';
			const match      = firstMatch.match(/^(\d+):\s*/);
			const line       = match ? Number.parseInt(match[1], 10) : 1;
			const excerpt    = await ctx.githubService.readFileLocalSnippet(result.path, ctx.branch, localRepoUrl, Math.max(1, line - 12), line + 20);
			return {...result, excerpt};
		} catch {
			return result;
		}
	}));
	return enriched;
}

export function formatUiCodeSearchResults(results: Array<{ path: string; matches: string[]; excerpt?: string; score?: number }>): string {
	if (!results || results.length === 0) {
		return '';
	}
	const lines: string[] = [];
	lines.push('UI CODE SEARCH RESULTS (SPY REPO)');
	lines.push('Use these as grounding for exact menu/button/page labels. Do NOT invent UI paths.');
	for (const r of results.slice(0, 6)) {
		lines.push(`- ${r.path}${typeof r.score === 'number' ? ` (score: ${r.score})` : ''}`);
		for (const m of (r.matches || []).slice(0, 3)) {
			const frag = String(m || '').replace(/\s+/g, ' ').trim();
			if (frag) {
				lines.push(`  - ${frag}`);
			}
		}
		if (r.excerpt) {
			lines.push('  - Excerpt:');
			for (const line of r.excerpt.split('\n').slice(0, 10)) {
				const trimmed = line.trim();
				if (trimmed) {
					lines.push(`    ${trimmed}`);
				}
			}
		}
	}
	return lines.join('\n');
}

export function formatToolsCodeSearchResults(results: Array<{ path: string; matches: string[]; excerpt?: string; score?: number }>): string {
	if (!results || results.length === 0) {
		return '';
	}
	const lines: string[] = [];
	lines.push('TOOLS/SCRIPTS CODE SEARCH RESULTS (SPY REPO)');
	lines.push('Use these to ground tool/script answers before considering UI pages.');
	lines.push('Prioritize matches inside tools or customer-scripts directories.');
	for (const r of results.slice(0, 6)) {
		lines.push(`- ${r.path}${typeof r.score === 'number' ? ` (score: ${r.score})` : ''}`);
		for (const m of (r.matches || []).slice(0, 4)) {
			const frag = String(m || '').replace(/\s+/g, ' ').trim();
			if (frag) {
				lines.push(`  - ${frag}`);
			}
		}
	}
	return lines.join('\n');
}

export function formatIntegrationCodeSearchResults(results: Array<{ path: string; matches: string[] }>): string {
	if (!results || results.length === 0) {
		return '';
	}
	const lines: string[] = [];
	lines.push('SETUP/HOW-TO CODE SEARCH RESULTS (SPY REPO)');
	lines.push('Use these to document exact user-facing setup steps and labels. Do NOT skip critical config or invent menu paths.');
	for (const r of results.slice(0, 8)) {
		lines.push(`- ${r.path}`);
		for (const m of (r.matches || []).slice(0, 4)) {
			const frag = String(m || '').replace(/\s+/g, ' ').trim();
			if (frag) {
				lines.push(`  - ${frag}`);
			}
		}
	}
	return lines.join('\n');
}

export function formatGroundingDebugPreview(section: string, maxLines: number = 18): string {
	const trimmed = section.trim();
	if (!trimmed) {
		return '';
	}
	const lines = trimmed.split('\n');
	if (lines.length <= maxLines) {
		return trimmed;
	}
	return `${lines.slice(0, maxLines).join('\n')}\n... [truncated ${lines.length - maxLines} more lines]`;
}

function scoreUiSearchResult(path: string, matches: string[], workflowTerms: string[]): number {
	const haystack = `${path}\n${matches.join('\n')}`.toLowerCase();
	let score      = 0;

	for (const term of workflowTerms) {
		if (term && haystack.includes(term.toLowerCase())) {
			score += 3;
		}
	}

	const positiveHints = ['sales', 'customer', 'order', 'create', 'index', 'overview', 'list', 'menu', 'nav', 'button', 'action', 'open', 'dialog', 'sidebar', 'route', 'navigation', 'entry'];
	const negativeHints = ['admin', 'config', 'setup', 'setting', 'validator', 'migration', 'script', 'tools/', 'customer-scripts', 'systemconfig', 'test'];

	for (const hint of positiveHints) {
		if (haystack.includes(hint)) {
			score += 2;
		}
	}
	for (const hint of negativeHints) {
		if (haystack.includes(hint)) {
			score -= 2;
		}
	}
	if (/\/(index|view)\.php\b/i.test(path)) {
		score += 4;
	}
	if (/controller/i.test(path)) {
		score += 1;
	}
	return score;
}
