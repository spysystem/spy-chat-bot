import type {IntentProfile} from './intent-profile';

export interface ContextBudget {
	historyMessages: number;
	vectorDocuments: number;
	followUpHistoryMessages: number;
	includeWorkingSummary: boolean;
	includeUiGrounding: boolean;
	includeIntegrationGrounding: boolean;
	includeToolsGrounding: boolean;
	includeDatabaseContext: boolean;
	includeDatabaseArchitecture: boolean;
	includeCodeArchitecture: boolean;
}

export function buildContextBudget(intent: IntentProfile): ContextBudget {
	const isUiOnly = intent.isUiQuestion
		&& !intent.hasConcreteIdentifier
		&& !intent.requiresDatabase
		&& !intent.requiresIntegrationFocus;

	const isRecordLookup = intent.hasConcreteIdentifier && intent.requiresDatabase;
	const isCodeFocused  = intent.requiresCodeFirst || intent.requiresHandlerNav || intent.isToolsOrScriptQuestion;
	const isAmbiguous    = !intent.requiresDatabase
		&& !intent.isUiQuestion
		&& !intent.isSetupOrHowToQuestion
		&& !isCodeFocused
		&& !intent.hasConcreteIdentifier;

	return {
		historyMessages            : isAmbiguous ? 6 : (isUiOnly ? 8 : (isRecordLookup ? 10 : 12)),
		vectorDocuments            : isAmbiguous ? 1 : (isRecordLookup ? 1 : (intent.requiresIntegrationFocus ? 2 : 3)),
		followUpHistoryMessages    : isUiOnly ? 2 : 4,
		includeWorkingSummary      : !isUiOnly && !isAmbiguous,
		includeUiGrounding         : intent.isUiQuestion || intent.requiresHandlerNav || intent.requiresCodeFirst,
		includeIntegrationGrounding: intent.isSetupOrHowToQuestion || intent.requiresIntegrationFocus,
		includeToolsGrounding      : intent.isToolsOrScriptQuestion,
		includeDatabaseContext     : intent.requiresDatabase || isRecordLookup,
		includeDatabaseArchitecture: intent.requiresDatabase && !isUiOnly,
		includeCodeArchitecture    : isCodeFocused || intent.isSetupOrHowToQuestion,
	};
}
