export interface LatencyFlags {
	enableLatencyMetrics: boolean;
	enablePreprocessParallel: boolean;
	enablePostProcessParallel: boolean;
	enableRetrievalCaches: boolean;
	enableContextCompaction: boolean;
	enableParallelToolCalls: boolean;
	useTanStackOpenAI: boolean;
	useUnifiedOrchestrator: boolean;
	useUnifiedPostProcessing: boolean;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	return raw === '1' || raw.toLowerCase() === 'true';
}

export const LATENCY_FLAGS: LatencyFlags = {
	enableLatencyMetrics     : parseBoolEnv('SPY_LATENCY_METRICS', true),
	enablePreprocessParallel : parseBoolEnv('SPY_LATENCY_PARALLEL_PREPROCESS', true),
	enablePostProcessParallel: parseBoolEnv('SPY_LATENCY_PARALLEL_POSTPROCESS', true),
	enableRetrievalCaches    : parseBoolEnv('SPY_LATENCY_RETRIEVAL_CACHE', true),
	enableContextCompaction  : parseBoolEnv('SPY_LATENCY_CONTEXT_COMPACTION', true),
	enableParallelToolCalls  : parseBoolEnv('SPY_LATENCY_PARALLEL_TOOLS', true),
	useTanStackOpenAI        : parseBoolEnv('SPY_USE_TANSTACK_OPENAI', true),
	useUnifiedOrchestrator   : parseBoolEnv('SPY_USE_UNIFIED_ORCHESTRATOR', true),
	useUnifiedPostProcessing : parseBoolEnv('SPY_USE_UNIFIED_POSTPROCESSING', true),
};
