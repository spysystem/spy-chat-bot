export interface EventForwarder {
	forward: (event: unknown) => void;
}

export function createEventForwarder(onEvent?: (event: unknown) => void): EventForwarder {
	return {
		forward: (event: unknown) => {
			onEvent?.(event);
		},
	};
}
