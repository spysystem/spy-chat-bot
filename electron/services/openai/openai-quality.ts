import {checkAnswerQuality} from '../shared/answer-quality';
import type {AnswerEvidenceItem, AnswerQualityCheck} from '../shared/answer-quality';

export interface OpenAiQualityDecision {
	qualityCheck: AnswerQualityCheck;
	shouldRetryTechnical: boolean;
}

export function decideOpenAiTechnicalRetry(input: {
	detailedAnswer: string;
	evidenceItems: AnswerEvidenceItem[];
	requiredDatabaseButNoQueries: boolean;
	uiAnswerNeedsRetry: boolean;
	midInvestigationNeedsRetry: boolean;
	nonAnswer: boolean;
	useTanStackOpenAI: boolean;
}): OpenAiQualityDecision {
	const qualityCheck = checkAnswerQuality(input.detailedAnswer, input.evidenceItems, {
		requiredDatabaseButNoQueries: input.requiredDatabaseButNoQueries,
		uiAnswerNeedsRetry          : input.uiAnswerNeedsRetry,
		midInvestigation            : input.midInvestigationNeedsRetry,
		nonAnswer                   : input.nonAnswer,
	});

	return {
		qualityCheck,
		shouldRetryTechnical: input.useTanStackOpenAI && qualityCheck.needsRetry,
	};
}

export function decideOpenAiCompletionPass(input: {
	detailedAnswer: string;
	evidenceItems: AnswerEvidenceItem[];
	agentLoopExhausted: boolean;
	looksLikeMidInvestigation: boolean;
}): {
	completionQualityCheck: AnswerQualityCheck;
	needsCompletionPass: boolean;
} {
	const completionQualityCheck = checkAnswerQuality(input.detailedAnswer, input.evidenceItems, {
		midInvestigation: input.agentLoopExhausted || input.looksLikeMidInvestigation,
	});

	return {
		completionQualityCheck,
		needsCompletionPass: input.evidenceItems.length > 0
			&& (input.agentLoopExhausted || input.looksLikeMidInvestigation || completionQualityCheck.needsRetry),
	};
}
