export type DesiredDetailLevel = 'short' | 'medium' | 'detailed';

export interface IntentProfile {
	desiredDetailLevel: DesiredDetailLevel;
	isToolsOrScriptQuestion: boolean;
	isUiQuestion: boolean;
	isSetupOrHowToQuestion: boolean;
	hasConcreteIdentifier: boolean;
	requiresCodeFirst: boolean;
	requiresHandlerNav: boolean;
	requiresDatabase: boolean;
	requiresIntegrationFocus: boolean;
}

export function buildIntentProfile(text: string): IntentProfile {
	const isToolsOrScriptQuestion  = detectsToolsOrScriptQuestion(text);
	const isUiQuestion             = looksLikeUiQuestion(text);
	const isSetupOrHowToQuestion   = looksLikeSetupOrHowToQuestion(text);
	const hasConcreteIdentifier    = hasConcreteRecordIdentifier(text);
	const requiresCodeFirst        = detectsPageModuleQuestion(text);
	const requiresHandlerNav       = detectsHandlerOrActionQuestion(text);
	const requiresIntegrationFocus = detectsIntegrationSetupQuestion(text);
	const requiresDatabase         = detectsDatabaseQuestion(text) && ((!isUiQuestion && !isSetupOrHowToQuestion) || hasConcreteIdentifier);

	return {
		desiredDetailLevel: detectDesiredDetailLevel(text),
		isToolsOrScriptQuestion,
		isUiQuestion,
		isSetupOrHowToQuestion,
		hasConcreteIdentifier,
		requiresCodeFirst,
		requiresHandlerNav,
		requiresDatabase,
		requiresIntegrationFocus,
	};
}

export function detectDesiredDetailLevel(text: string): DesiredDetailLevel {
	const t                 = text.toLowerCase();
	const asksForTechnical  = /(\bcode\b|\bkode\b|\bsql\b|\bquery\b|\bklasse\b|\bclass\b|\bfil\b|\bfile\b|\blinje\b|\bline\b|\bstack\b|\btrace\b|\bfejl\b|\berror\b|\bdebug\b|\bipc\b|\belectron\b|\bnode\b|\breact\b|\btypescript\b|\bapi\b)/i.test(t);
	const asksForMoreDetail = /(\bforklar\b|\bexplain\b|\bhvorfor\b|\bwhy\b|\bdetalj\w*\b|\bdetailed\b|\bdybdegående\b|\bgrundigt\b|\btrin\b|\bstep\b|\bguide\b|\bhow\s+does\b|\bhvordan\s+virker\b)/i.test(t);
	const asksForShort      = /(\bkort\b|\bbrief\b|\bquick\b|\btl;?dr\b|\bopsummer\b|\bsummarize\b|\bsummary\b|\bjust\s+tell\b|\bbare\s+svar\b)/i.test(t);

	if (asksForTechnical || asksForMoreDetail) {
		return 'detailed';
	}
	if (asksForShort) {
		return 'short';
	}
	return 'medium';
}

export function looksLikeUiQuestion(text: string): boolean {
	const t                  = text.toLowerCase();
	const hasExplicitUiTerms = /(\bklik\b|\bknap\b|\bmenu\b|\bfane\b|\bfelt\b|\bside\b|\bskærm\b|\bui\b|\binterface\b|\bredig(é|e)r\b|\bslet\b|\bfilter\b|\boversigt\b|\bbutton\b|\bpage\b|\bfield\b|\bnavigation\b|\bnav\b|\bsidebar\b)/i.test(t);
	const asksUiLocation     = /\b(hvordan|how|hvor|where|find|finder|åbn|open|gå\s+til)\b/i.test(t) && /(\bmenu\b|\bside\b|\bskærm\b|\bfane\b|\btab\b|\bknap\b|\bbutton\b|\bfield\b|\bpage\b|\bnavigation\b|\bnav\b)/i.test(t);
	if (detectsToolsOrScriptQuestion(text) && !(hasExplicitUiTerms || asksUiLocation)) {
		return false;
	}
	return hasExplicitUiTerms || asksUiLocation;
}

export function looksLikeSetupOrHowToQuestion(text: string): boolean {
	const t = text.toLowerCase();
	return /\b(hvordan|how)\s+(opsætter|gør|konfigurerer|set\s+up|setup|configure|do\s+i|laver|opretter)\b/i.test(t)
		|| /\b(where|hvor)\s+(do\s+i|finder|kan\s+jeg|opretter|konfigurerer)\b/i.test(t)
		|| /\b(opsæt|opsætte|konfigurer|setup|opret|create)\s+(jeg|i|we)?\s*(spy|systemet|ordre|order)?/i.test(t)
		|| detectsIntegrationSetupQuestion(text);
}

export function hasConcreteRecordIdentifier(text: string): boolean {
	const t = text.toLowerCase();
	return /\b(ordre|order|kunde|customer|faktura|invoice|retur|return)\s*[:#]?\s*\d+\b/i.test(t)
		|| /\b(id|nummer|number|#)\s*:?\s*\d+/i.test(t)
		|| /#\d+|\b\d{4,}\b/.test(t);
}

export function detectsToolsOrScriptQuestion(text: string): boolean {
	const t = text.toLowerCase();
	return /\b(tool|tools|script|scripts|customer-scripts|customerscripts|cron|job)\b/i.test(t);
}

export function buildToolsScriptQueries(text: string): string[] {
	const keywords  = extractSearchKeywords(text, 5);
	const baseTerms = keywords.length > 0 ? keywords : [text];
	const querySets = [
		['path:tools', ...baseTerms],
		['path:customer-scripts', ...baseTerms],
		['path:public/javascript/Controller', ...baseTerms, 'tool'],
		[...baseTerms, 'tools', 'script'],
	];

	return uniqueQueries(querySets);
}

export function buildUiGroundingQueries(text: string): string[] {
	const keywords      = extractSearchKeywords(text, 5);
	const baseTerms     = keywords.length > 0 ? keywords : [text];
	const workflowTerms = extractUiWorkflowTerms(text);
	const querySets     = [
		[...baseTerms, ...workflowTerms, 'menu', 'navigation', 'sidebar'],
		[...baseTerms, 'entry', 'menu', 'nav', 'route', 'overview', 'index'],
		['path:public/javascript/Controller', ...baseTerms, 'menu', 'navigation', 'open'],
		[...baseTerms, 'create', 'open', 'action', 'spyaction', 'dialog'],
	];

	return uniqueQueries(querySets);
}

export function extractUiWorkflowTerms(text: string): string[] {
	const t               = text.toLowerCase();
	const terms: string[] = [];
	if (/\b(order|ordre)\b/i.test(t)) {
		terms.push('order', 'sales');
	}
	if (/\b(customer|kunde)\b/i.test(t)) {
		terms.push('customer');
	}
	if (/\b(return|retur)\b/i.test(t)) {
		terms.push('return');
	}
	if (/\b(create|opret|new|ny)\b/i.test(t)) {
		terms.push('create');
	}
	if (/\b(edit|rediger|update|ændr)\b/i.test(t)) {
		terms.push('edit');
	}
	if (/\b(open|åbn|find|gå til|where|hvor)\b/i.test(t)) {
		terms.push('open', 'navigation');
	}
	return terms;
}

export function detectsIntegrationSetupQuestion(text: string): boolean {
	const t                  = text.toLowerCase();
	const setupIntent        = /\b(opsæt|opsætte|opsætter|setup|oprette|konfigurer|configure|knytte|knytter|connect|link|forbinde|tilkoble|integrat|integration)\b/i.test(t);
	const integrationMention = /\b(shopify|pos|woocommerce|sitoo|edi|nemedi|dhl|ups|fedex|gls|postnord|bring|webhook|api\s+key)\b/i.test(t);
	if (setupIntent && integrationMention) {
		return true;
	}
	if (/\b(hvordan|how)\s+(opsætter|set\s+up|setup|konfigurerer|configure)\s+(jeg|i|we)?\s*(shopify|pos|woo|sitoo|edi|integration)/i.test(t)) {
		return true;
	}
	return /\b(knytte|connect|link)\s+(til|to)\s+(min|mit|my)\s*(shop|butik)/i.test(t);
}

export function detectsPageModuleQuestion(text: string): boolean {
	const t = text.toLowerCase();
	if (/\b(side(n)?|page|modul|module|skærm|screen|liste|list|oversigt|overview)\s+(viser|shows|har|has)\b/i.test(t)) {
		return true;
	}
	if (/\b(hvorfor|why)\s+(viser|shows|står|er)\b/i.test(t)) {
		return true;
	}
	if (/\b(confident|topseller|sales\/create|b2b|b2c|claims|warehouse)\b/i.test(t) && /\b(viser|shows|default|standard|forkert|wrong|anderledes|different)\b/i.test(t)) {
		return true;
	}
	return /\b(forskellig|different|anderledes|ikke det samme|not the same)\b/i.test(t) && /\b(side|page|modul|module|sted|place)\b/i.test(t);
}

export function detectsHandlerOrActionQuestion(text: string): boolean {
	const t = text.toLowerCase();
	if (/\baction[-_]\w+/i.test(t) || /\b(spy\s*action|data-spyaction)\b/i.test(t)) {
		return true;
	}
	if (/\b(handler|action|modal|dialog|popup|dialogue|dialogboks)\b/i.test(t) && /\b(spy|modul|module|side|page|knap|button|klik|click|åbn|open|luk|close|viser|shows)\b/i.test(t)) {
		return true;
	}
	if (/\b(åbner?|opens?|viser|shows|popper?\s+op|pops?\s+up)\b/i.test(t) && /\b(dialog|modal|popup|vindue|window|boks|box|formular|form)\b/i.test(t)) {
		return true;
	}
	if (/\bopen[A-Z]\w+/i.test(text) || /\bshow[A-Z]\w+dialog/i.test(text)) {
		return true;
	}
	return /\b(hvad\s+sker|what\s+happens)\b/i.test(t) && /\b(klik|click|tryk|press|knap|button)\b/i.test(t);
}

export function detectsDatabaseQuestion(text: string): boolean {
	const t = text.toLowerCase();
	if (/\b(hvor\s+mange|how\s+many|antal|count|total|sum|average|gennemsnit)\b/i.test(t)) {
		return true;
	}
	if (/\b(vis\s+(mig\s+)?(alle|en\s+liste)|show\s+(me\s+)?(all|a\s+list)|list\s+all|hvilke|which)\b/i.test(t)) {
		return true;
	}
	if (/\b(ordre|order|kunde|customer|faktura|invoice|retur|return|produkt|product|vare|item|leverandør|supplier|brand|sælger|seller|user|bruger)\s*[:#]?\s*\d+\b/i.test(t)) {
		return true;
	}
	if (/\b(id|nummer|number|#)\s*:?\s*\d+/i.test(t) || /#\d+|\b\d{4,}\b/.test(t)) {
		return true;
	}
	if (/\bi\s+(mit\s+)?system(et)?\b/i.test(t)) {
		return true;
	}
	if (/\b(brugere?|users?|kunder?|customers?|ordrer?|orders?|produkter?|products?|varer?|items?|fakturaer?|invoices?|returneringer?|returns?|leverandører?|suppliers?|brands?|sælgere?|sellers?|lager|stock|inventory|shipments?|forsendelser?|betalinger?|payments?)\b/i.test(t)) {
		return true;
	}
	if (/\b(status|saldo|balance|beløb|amount|pris|price|dato|date|oprettet|created|ændret|changed|aktiv|active|inaktiv|inactive|disabled)\b/i.test(t)) {
		return true;
	}
	if (/\b(hvorfor|why|hvornår|when|hvem|who|tjek|check|undersøg|investigate|find\s+ud\s+af|find\s+out)\b/i.test(t)) {
		return true;
	}
	return /\b(sales|b2b|b2c|shopify|edi|claims|warehouse|shipping|confident)\b/i.test(t);
}

export function extractSearchKeywords(text: string, max: number = 4): string[] {
	const stop  = new Set([
		'hvordan', 'hvor', 'hvad', 'hvem', 'hvorfor', 'kan', 'jeg', 'vi', 'man', 'min', 'mit', 'mine',
		'how', 'where', 'what', 'who', 'why', 'can', 'could', 'should', 'the', 'and', 'for', 'with', 'from',
		'til', 'med', 'fra', 'der', 'det', 'den', 'this', 'that', 'please', 'venligst',
	]);
	return Array.from(new Set((text.match(/[A-Za-zÆØÅæøå0-9_/-]{3,}/g) || [])
		.map((w) => w.toLowerCase())
		.filter((w) => !stop.has(w))))
		.slice(0, max);
}

function uniqueQueries(querySets: string[][]): string[] {
	return querySets
		.map((parts) => Array.from(new Set(parts.filter(Boolean))).slice(0, 7).join(' '))
		.filter((query, index, arr) => query.trim() !== '' && arr.indexOf(query) === index);
}
