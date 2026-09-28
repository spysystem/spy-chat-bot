import * as fs from 'fs/promises';
import * as path from 'path';

const promptCache = new Map<string, string>();

export async function loadPromptAsset(assetName: string): Promise<string> {
	if (promptCache.has(assetName)) {
		return promptCache.get(assetName) || '';
	}

	const assetPath = path.join(__dirname, '../../../assets/prompts', assetName);
	try {
		const raw    = await fs.readFile(assetPath, 'utf-8');
		const prompt = stripFrontmatter(raw).trim();
		promptCache.set(assetName, prompt);
		return prompt;
	} catch {
		promptCache.set(assetName, '');
		return '';
	}
}

function stripFrontmatter(value: string): string {
	if (!value.startsWith('---')) {
		return value;
	}

	const closingIndex = value.indexOf('\n---', 3);
	if (closingIndex === -1) {
		return value;
	}

	return value.slice(closingIndex + 4);
}
