export type AnswerEvidenceKind =
	| 'schema_lookup'
	| 'database_query'
	| 'code_search'
	| 'code_context'
	| 'file_read'
	| 'mcp_index'
	| 'csv_export';

export interface AnswerEvidenceItem {
	kind: AnswerEvidenceKind;
	label: string;
	detail?: string;
	rowCount?: number;
	resultCount?: number;
	verified: boolean;
}

export interface AnswerQualityCheck {
	needsRetry: boolean;
	reasons: string[];
}

export function addAnswerEvidence(items: AnswerEvidenceItem[] | undefined, item: AnswerEvidenceItem): void {
	if (!items) {
		return;
	}
	items.push({
		...item,
		label : compactText(item.label, 160),
		detail: item.detail ? compactText(item.detail, 240) : undefined,
	});
}

export function hasVerifiedEvidence(items: AnswerEvidenceItem[]): boolean {
	return items.some((item) => item.verified);
}

export function hasStrongVerifiedEvidence(items: AnswerEvidenceItem[]): boolean {
	return items.some((item) =>
		item.kind === 'database_query'
		|| item.kind === 'code_context'
		|| item.kind === 'file_read'
		|| item.kind === 'schema_lookup',
	);
}

export function formatAnswerEvidenceSummary(items: AnswerEvidenceItem[], maxItems: number = 12): string {
	if (items.length === 0) {
		return 'No tool evidence was captured for this run.';
	}

	const counts = items.reduce<Record<AnswerEvidenceKind, number>>((acc, item) => {
		acc[item.kind] = (acc[item.kind] || 0) + 1;
		return acc;
	}, {
		schema_lookup : 0,
		database_query: 0,
		code_search   : 0,
		code_context  : 0,
		file_read     : 0,
		mcp_index     : 0,
		csv_export    : 0,
	});

	const countsText = [
		`database queries: ${counts.database_query}`,
		`schema lookups: ${counts.schema_lookup}`,
		`verified code snippets/files: ${counts.code_context + counts.file_read}`,
		`code searches: ${counts.code_search}`,
		`MCP indexed hits: ${counts.mcp_index}`,
	].join(', ');

	const bullets = items
		.slice(-maxItems)
		.map((item) => {
			const meta: string[] = [];
			if (typeof item.rowCount === 'number') {
				meta.push(`${item.rowCount} rows`);
			}
			if (typeof item.resultCount === 'number') {
				meta.push(`${item.resultCount} results`);
			}
			meta.push(item.verified ? 'verified' : 'discovery only');
			const detail = item.detail ? ` - ${item.detail}` : '';
			return `- ${item.kind}: ${item.label}${meta.length > 0 ? ` (${meta.join(', ')})` : ''}${detail}`;
		})
		.join('\n');

	return `Evidence captured: ${countsText}\n${bullets}`;
}

export function buildAnswerQualityDirective(evidenceSummary: string): string {
	return `
ANSWER QUALITY & EVIDENCE RULES:
- Use the evidence summary below to decide how strong the final answer can be.
- Start with the strongest conclusion supported by verified evidence.
- If verified database rows, schema lookups, code snippets, or file reads answer the question, do NOT add a generic uncertainty heading such as "Usikkert", "ikke fuldt verificeret", "not fully verified", or similar.
- Mention uncertainty only when a required evidence type is missing, and make it specific: what is missing and how that limits the answer.
- MCP/indexed search hits and plain code search results are discovery evidence. Treat them as hints until a file snippet/read or database result verifies the claim.
- Do not end with "I can investigate further" when the evidence already supports a useful answer.

${evidenceSummary}`;
}

export function checkAnswerQuality(
	answer: string,
	items: AnswerEvidenceItem[],
	options: {
		requiredDatabaseButNoQueries?: boolean;
		uiAnswerNeedsRetry?: boolean;
		midInvestigation?: boolean;
		nonAnswer?: boolean;
	} = {},
): AnswerQualityCheck {
	const reasons: string[] = [];
	if (options.requiredDatabaseButNoQueries) {
		reasons.push('required database access was not used');
	}
	if (options.uiAnswerNeedsRetry) {
		reasons.push('UI answer is insufficiently grounded');
	}
	if (options.midInvestigation) {
		reasons.push('answer appears to stop mid-investigation');
	}
	if (options.nonAnswer) {
		reasons.push('answer is non-responsive');
	}
	if (hasWeakUncertaintyDisclaimer(answer, hasStrongVerifiedEvidence(items))) {
		reasons.push('answer contains unnecessary or generic uncertainty language');
	}
	if (offersToInvestigateInsteadOfAnswering(answer) && hasVerifiedEvidence(items)) {
		reasons.push('answer offers further investigation despite available evidence');
	}
	return {
		needsRetry: reasons.length > 0,
		reasons,
	};
}

export function hasWeakUncertaintyDisclaimer(answer: string, hasStrongEvidence: boolean): boolean {
	const t = String(answer || '');
	if (!t.trim()) {
		return false;
	}
	const genericUncertainty = [
		/\busikkert\b/i,
		/\bikke\s+fuldt\s+verificeret\b/i,
		/\bikke\s+verificeret\b/i,
		/\bnot\s+fully\s+verified\b/i,
		/\bnot\s+verified\b/i,
		/\bcan(?:not|'t)\s+verify\b/i,
		/\bkan\s+ikke\s+verificere\b/i,
		/\bbaseret\s+på\s+begrænset\s+(?:data|information)\b/i,
		/\bbased\s+on\s+limited\s+(?:data|information)\b/i,
	];
	if (!genericUncertainty.some((re) => re.test(t))) {
		return false;
	}
	return hasStrongEvidence || /^#{1,4}\s*(usikkert|not fully verified|ikke fuldt verificeret)/im.test(t);
}

export function offersToInvestigateInsteadOfAnswering(answer: string): boolean {
	const t = String(answer || '');
	return /\bhvis\s+du\s+vil\b.{0,80}\bkan\s+jeg\b.{0,120}\b(undersøge|tjekke|finde|grave|kigge)\b/i.test(t)
		|| /\bif\s+you\s+want\b.{0,80}\bi\s+can\b.{0,120}\b(investigate|check|find|look)\b/i.test(t);
}

function compactText(text: string, maxChars: number): string {
	const normalized = String(text || '').replace(/\s+/g, ' ').trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}
