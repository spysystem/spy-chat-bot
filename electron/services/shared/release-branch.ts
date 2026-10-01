interface SystemReleases {
	release?: string;
	targetRelease?: string;
	nextRelease?: string;
}

function normalizeBranchLikeValue(value: string): string {
	return value
		.trim()
		.replace(/^refs\/heads\//i, '')
		.replace(/-/g, '_');
}

function releaseToBranch(release: unknown): string | null {
	const rawValue = String(release ?? '').trim();
	if (!rawValue) {
		return null;
	}

	const value = normalizeBranchLikeValue(rawValue);
	if (!value) {
		return null;
	}

	if (/^\d{4}_\d{2}_\d{2}$/.test(value) || /^\d{4}_\d{2}$/.test(value)) {
		return value;
	}

	// 202512.1 -> 2025_12_10
	const fullMatch = value.match(/^(\d{4})(\d{2})\.(\d+)$/);
	if (fullMatch) {
		const [, year, month, patchRaw] = fullMatch;
		// If the patch part is a single digit (e.g. "1"), treat it as tens ("10").
		// This matches the SPY git branch naming convention.
		const patchNum   = Number.parseInt(patchRaw, 10);
		const patchValue = Number.isFinite(patchNum)
			? (patchRaw.length === 1 ? patchNum * 10 : patchNum)
			: patchRaw;
		const patch      = String(patchValue).padStart(2, '0');
		return `${year}_${month}_${patch}`;
	}

	// 202512 -> 2025_12
	const shortMatch = value.match(/^(\d{4})(\d{2})$/);
	if (shortMatch) {
		const [, year, month] = shortMatch;
		return `${year}_${month}`;
	}

	// 20251210 -> 2025_12_10
	const compactFullMatch = value.match(/^(\d{4})(\d{2})(\d{2})$/);
	if (compactFullMatch) {
		const [, year, month, patch] = compactFullMatch;
		return `${year}_${month}_${patch}`;
	}

	return null;
}

/** The git branch for the release a system runs (falling back to its target/next release), or ''. */
export function resolveSystemBranch(system: SystemReleases): string {
	const candidates = [system.release, system.targetRelease, system.nextRelease];
	for (const candidate of candidates) {
		const branch = releaseToBranch(candidate);
		if (branch) {
			return branch;
		}
	}
	return '';
}
