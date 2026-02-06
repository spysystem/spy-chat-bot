import {app} from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface UserSettings {
	userName?: string;
	localRepoUrl?: string;
}

export class SettingsService {
	private getSettingsPath(): string {
		const userDataPath = app.getPath('userData');
		return path.join(userDataPath, 'user-settings.json');
	}

	async getSettings(): Promise<UserSettings> {
		try {
			const settingsPath = this.getSettingsPath();
			if (fs.existsSync(settingsPath)) {
				const data = fs.readFileSync(settingsPath, 'utf-8');
				return JSON.parse(data);
			}
		} catch (error) {
			console.error('[SettingsService] Error reading settings:', error);
		}
		return {};
	}

	async saveSettings(settings: UserSettings): Promise<void> {
		try {
			const userDataPath = app.getPath('userData');
			if (!fs.existsSync(userDataPath)) {
				fs.mkdirSync(userDataPath, {recursive: true});
			}

			const settingsPath = this.getSettingsPath();
			fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
		} catch (error) {
			console.error('[SettingsService] Error saving settings:', error);
			throw error;
		}
	}

	async getUserName(): Promise<string | null> {
		const settings = await this.getSettings();
		return settings.userName || null;
	}

	async saveUserName(userName: string): Promise<void> {
		const settings    = await this.getSettings();
		settings.userName = userName;
		await this.saveSettings(settings);
	}

	async getLocalRepoUrl(): Promise<string | null> {
		const settings = await this.getSettings();
		return settings.localRepoUrl || null;
	}

	async saveLocalRepoUrl(localRepoUrl: string): Promise<void> {
		const settings        = await this.getSettings();
		settings.localRepoUrl = localRepoUrl;
		await this.saveSettings(settings);
	}

}
