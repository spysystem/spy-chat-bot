import {app, safeStorage} from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * SecureStorageService - Handles encrypted storage of sensitive data
 *
 * Uses Electron's safeStorage API which leverages OS-native encryption:
 * - Windows: DPAPI (Data Protection API)
 * - macOS: Keychain
 * - Linux: Secret Service API (libsecret)
 *
 * Encrypted data is tied to the user's OS login credentials.
 */
export class SecureStorageService {
	private readonly securePath: string;

	constructor() {
		// Store encrypted data in a separate 'secure' subdirectory
		this.securePath = path.join(app.getPath('userData'), 'secure');
	}

	/**
	 * Ensure secure directory exists
	 */
	private async ensureSecureDir(): Promise<void> {
		try {
			await fs.mkdir(this.securePath, {recursive: true});
		} catch (error) {
			console.error('Failed to create secure directory:', error);
		}
	}

	/**
	 * Check if safeStorage is available
	 */
	isEncryptionAvailable(): boolean {
		return safeStorage.isEncryptionAvailable();
	}

	/**
	 * Save encrypted string to file
	 */
	async saveEncrypted(key: string, value: string): Promise<void> {
		if (!this.isEncryptionAvailable()) {
			throw new Error('Encryption not available on this system');
		}

		await this.ensureSecureDir();

		// Encrypt the value
		const encrypted = safeStorage.encryptString(value);

		// Save to file with .encrypted extension
		const filePath = path.join(this.securePath, `${key}.encrypted`);
		await fs.writeFile(filePath, encrypted);

		console.log(`[SecureStorage] Saved encrypted data: ${key}`);
	}

	/**
	 * Load and decrypt string from file
	 */
	async loadEncrypted(key: string): Promise<string | null> {
		if (!this.isEncryptionAvailable()) {
			throw new Error('Encryption not available on this system');
		}

		try {
			const filePath  = path.join(this.securePath, `${key}.encrypted`);
			const encrypted = await fs.readFile(filePath);

			// Decrypt the value
			return safeStorage.decryptString(encrypted);
		} catch (error) {
			// File doesn't exist or can't be read
			return null;
		}
	}

	/**
	 * Delete encrypted file
	 */
	async deleteEncrypted(key: string): Promise<void> {
		try {
			const filePath = path.join(this.securePath, `${key}.encrypted`);
			await fs.unlink(filePath);
			console.log(`[SecureStorage] Deleted encrypted data: ${key}`);
		} catch (error) {
			// File doesn't exist, ignore
		}
	}
}
