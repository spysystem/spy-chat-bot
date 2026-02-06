import {execFile, spawn} from 'child_process';
import {app, dialog} from 'electron';
import * as fs from 'fs/promises';
import * as https from 'https';
import * as path from 'path';
import {promisify} from 'util';

const execFileAsync = promisify(execFile);

export interface GitInstallProgress {
	stage: 'checking' | 'downloading' | 'installing' | 'complete' | 'error';
	percent?: number;
	message: string;
}

export class GitInstallerService {
	private isInstalling = false;

	/**
	 * Check if Git is installed and available in PATH.
	 */
	async isGitInstalled(): Promise<boolean> {
		try {
			await execFileAsync('git', ['--version']);
			return true;
		} catch (error) {
			const err = error as { code?: string };
			if (err.code === 'ENOENT') {
				return false;
			}
			// Git exists but had some other error - consider it installed
			return true;
		}
	}

	/**
	 * Get the installed Git version, or null if not installed.
	 */
	async getGitVersion(): Promise<string | null> {
		try {
			const {stdout} = await execFileAsync('git', ['--version']);
			const match    = stdout.match(/git version ([\d.]+)/);
			return match ? match[1] : stdout.trim();
		} catch {
			return null;
		}
	}

	/**
	 * Prompt user to install Git and handle the installation.
	 * Returns true if Git is now available, false if user cancelled or installation failed.
	 */
	async promptAndInstall(
		onProgress?: (progress: GitInstallProgress) => void,
	): Promise<boolean> {
		if (this.isInstalling) {
			return false;
		}

		// Check if already installed
		if (await this.isGitInstalled()) {
			onProgress?.({stage: 'complete', message: 'Git is already installed.'});
			return true;
		}

		// Only support Windows auto-install for now
		if (process.platform !== 'win32') {
			const result = await dialog.showMessageBox({
				type     : 'info',
				title    : 'Git Required',
				message  : 'Git is not installed',
				detail   : process.platform === 'darwin'
					? 'Please install Git using Homebrew:\n\nbrew install git\n\nOr download from https://git-scm.com/downloads'
					: 'Please install Git using your package manager:\n\nsudo apt install git\n\nOr download from https://git-scm.com/downloads',
				buttons  : ['Open Download Page', 'Cancel'],
				defaultId: 0,
			});

			if (result.response === 0) {
				const {shell} = await import('electron');
				await shell.openExternal('https://git-scm.com/downloads');
			}
			return false;
		}

		// Windows: Offer to download and install
		const result = await dialog.showMessageBox({
			type     : 'question',
			title    : 'Git Required',
			message  : 'Git is not installed',
			detail   : 'Git is required for Local Repository Sync.\n\nWould you like to download and install Git now?\n\nThis will download ~50MB and install Git silently.',
			buttons  : ['Download and Install', 'Cancel'],
			defaultId: 0,
			cancelId : 1,
		});

		if (result.response !== 0) {
			return false;
		}

		this.isInstalling = true;
		try {
			return await this.downloadAndInstallGit(onProgress);
		} finally {
			this.isInstalling = false;
		}
	}

	/**
	 * Download and install Git for Windows.
	 */
	private async downloadAndInstallGit(
		onProgress?: (progress: GitInstallProgress) => void,
	): Promise<boolean> {
		const tempDir       = app.getPath('temp');
		const installerPath = path.join(tempDir, 'Git-Installer.exe');

		console.log('[GitInstaller] Starting Git download and install process');
		console.log('[GitInstaller] Installer will be saved to:', installerPath);

		try {
			// Step 1: Get latest release URL from GitHub
			onProgress?.({stage: 'checking', message: 'Finding latest Git version...'});
			console.log('[GitInstaller] Fetching latest release info from GitHub...');
			const downloadUrl = await this.getLatestGitInstallerUrl();
			console.log('[GitInstaller] Download URL:', downloadUrl);

			// Step 2: Download installer
			onProgress?.({stage: 'downloading', percent: 0, message: 'Downloading Git installer...'});
			console.log('[GitInstaller] Starting download...');
			await this.downloadFile(downloadUrl, installerPath, (percent) => {
				onProgress?.({stage: 'downloading', percent, message: `Downloading Git installer... ${percent}%`});
				if (percent % 25 === 0) {
					console.log(`[GitInstaller] Download progress: ${percent}%`);
				}
			});
			console.log('[GitInstaller] Download complete');

			// Verify the file was downloaded
			try {
				const stats = await fs.stat(installerPath);
				console.log('[GitInstaller] Installer file size:', stats.size, 'bytes');
				if (stats.size < 1000000) {
					throw new Error('Downloaded file is too small - download may have failed');
				}
			} catch (statError) {
				throw new Error(`Failed to verify downloaded installer: ${statError}`);
			}

			// Step 3: Run installer with UAC elevation
			onProgress?.({stage: 'installing', message: 'Installing Git - please click "Yes" on the UAC prompt...'});
			console.log('[GitInstaller] Launching installer with UAC elevation...');
			await this.runInstaller(installerPath);
			console.log('[GitInstaller] Installer finished');

			// Step 4: Verify installation
			// Need to wait a bit and refresh PATH
			await this.sleep(2000);

			// Try to find git in common locations if not in PATH yet
			const gitInstalled = await this.verifyGitInstallation();

			if (gitInstalled) {
				onProgress?.({stage: 'complete', message: 'Git installed successfully!'});
				return true;
			} else {
				onProgress?.({
					stage  : 'error',
					message: 'Git was installed but requires a restart. Please restart the application.',
				});
				// Show dialog about restart
				await dialog.showMessageBox({
					type   : 'info',
					title  : 'Restart Required',
					message: 'Git installed successfully!',
					detail : 'Please restart Spørge Jansen to use Local Repository Sync.',
					buttons: ['OK'],
				});
				return false;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			onProgress?.({stage: 'error', message: `Installation failed: ${message}`});

			await dialog.showMessageBox({
				type   : 'error',
				title  : 'Installation Failed',
				message: 'Failed to install Git',
				detail : message,
				buttons: ['OK'],
			});
			return false;
		} finally {
			// Clean up installer
			try {
				await fs.unlink(installerPath);
			} catch {
				// Ignore cleanup errors
			}
		}
	}

	/**
	 * Get the download URL for the latest Git for Windows installer.
	 */
	private async getLatestGitInstallerUrl(): Promise<string> {
		// Fallback URL in case GitHub API fails (rate limits, etc.)
		const fallbackUrl = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe';

		return new Promise((resolve) => {
			const options = {
				hostname: 'api.github.com',
				path    : '/repos/git-for-windows/git/releases/latest',
				headers : {
					'User-Agent': 'Sporge-Jorgen-App',
					'Accept'    : 'application/vnd.github+json',
				},
			};

			const req = https.get(options, (res) => {
				// Handle rate limiting - use fallback
				if (res.statusCode === 403 || res.statusCode === 429) {
					console.log('[GitInstaller] GitHub API rate limited, using fallback URL');
					resolve(fallbackUrl);
					return;
				}

				let data = '';
				res.on('data', (chunk) => {
					data += chunk;
				});
				res.on('end', () => {
					try {
						const release = JSON.parse(data);

						// Check for API error response
						if (release.message) {
							console.log('[GitInstaller] GitHub API error:', release.message, '- using fallback');
							resolve(fallbackUrl);
							return;
						}

						// Find the 64-bit installer
						const asset = release.assets?.find((a: { name: string }) =>
							a.name.match(/Git-[\d.]+-64-bit\.exe$/i),
						);
						if (asset?.browser_download_url) {
							resolve(asset.browser_download_url);
						} else {
							console.log('[GitInstaller] No 64-bit installer found in release, using fallback');
							resolve(fallbackUrl);
						}
					} catch (e) {
						console.log('[GitInstaller] Failed to parse release data, using fallback:', e);
						resolve(fallbackUrl);
					}
				});
			});

			req.on('error', (error) => {
				console.log('[GitInstaller] GitHub API request failed, using fallback:', error.message);
				resolve(fallbackUrl);
			});

			// Timeout after 10 seconds
			req.setTimeout(10000, () => {
				console.log('[GitInstaller] GitHub API timeout, using fallback');
				req.destroy();
				resolve(fallbackUrl);
			});
		});
	}

	/**
	 * Download a file with progress tracking.
	 */
	private async downloadFile(
		url: string,
		destPath: string,
		onProgress?: (percent: number) => void,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const followRedirect = (downloadUrl: string) => {
				const protocol = downloadUrl.startsWith('https') ? https : require('http');

				protocol.get(downloadUrl, (res: any) => {
					// Handle redirects
					if (res.statusCode === 302 || res.statusCode === 301) {
						followRedirect(res.headers.location);
						return;
					}

					if (res.statusCode !== 200) {
						reject(new Error(`Download failed with status ${res.statusCode}`));
						return;
					}

					const totalSize    = parseInt(res.headers['content-length'] || '0', 10);
					let downloadedSize = 0;

					const fileStream = require('fs').createWriteStream(destPath);

					res.on('data', (chunk: Buffer) => {
						downloadedSize += chunk.length;
						if (totalSize > 0) {
							const percent = Math.round((downloadedSize / totalSize) * 100);
							onProgress?.(percent);
						}
					});

					res.pipe(fileStream);

					fileStream.on('finish', () => {
						fileStream.close();
						resolve();
					});

					fileStream.on('error', (err: Error) => {
						require('fs').unlink(destPath, () => {
						});
						reject(err);
					});
				}).on('error', reject);
			};

			followRedirect(url);
		});
	}

	/**
	 * Run the Git installer with UAC elevation.
	 * On Windows, we need admin rights to install to Program Files.
	 */
	private async runInstaller(installerPath: string): Promise<void> {
		// Silent install with sensible defaults
		// /VERYSILENT = no UI at all
		// /SILENT = shows progress bar but no prompts
		// /NORESTART = don't restart
		// /NOCANCEL = can't cancel
		// /SP- = don't show "This will install..." prompt
		// /CLOSEAPPLICATIONS = close apps using Git
		// /COMPONENTS = select components (git, bash, gitlfs, etc.)
		const args = [
			'/SILENT',  // Changed from /VERYSILENT to show progress bar
			'/NORESTART',
			'/NOCANCEL',
			'/SP-',
			'/CLOSEAPPLICATIONS',
			'/COMPONENTS=icons,ext,ext\\shellhere,ext\\guihere,gitlfs,assoc,assoc_sh',
		].join(' ');

		return new Promise((resolve, reject) => {
			// Use PowerShell's Start-Process with -Verb RunAs for UAC elevation
			// This will show the UAC prompt and then the installer progress
			const psScript = `
				$ErrorActionPreference = 'Stop'
				try {
					$process = Start-Process -FilePath '${installerPath.replace(/'/g, "''")}' -ArgumentList '${args}' -Verb RunAs -Wait -PassThru
					exit $process.ExitCode
				} catch {
					Write-Error $_.Exception.Message
					exit 1
				}
			`;

			const child = spawn('powershell.exe', [
				'-NoProfile',
				'-NonInteractive',
				'-ExecutionPolicy', 'Bypass',
				'-Command', psScript,
			], {
				windowsHide: false,  // Show PowerShell window for debugging
				shell      : false,
			});

			let stderr = '';
			child.stderr?.on('data', (data) => {
				stderr += data.toString();
			});

			child.on('error', (error) => {
				console.error('[GitInstaller] Spawn error:', error);
				reject(new Error(`Failed to start installer: ${error.message}`));
			});

			child.on('close', (code) => {
				console.log('[GitInstaller] Installer exited with code:', code);
				if (code === 0) {
					resolve();
				} else {
					// Check if user cancelled UAC
					if (stderr.includes('canceled by the user') || stderr.includes('denied') || code === 1) {
						reject(new Error('Installation was cancelled. Please try again and click "Yes" on the UAC prompt.'));
					} else {
						reject(new Error(`Installer exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`));
					}
				}
			});
		});
	}

	/**
	 * Verify Git is installed, checking common locations if not in PATH.
	 */
	private async verifyGitInstallation(): Promise<boolean> {
		// First try PATH
		if (await this.isGitInstalled()) {
			return true;
		}

		// Check common Windows install locations
		const commonPaths = [
			'C:\\Program Files\\Git\\cmd\\git.exe',
			'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
			path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
		];

		for (const gitPath of commonPaths) {
			try {
				await fs.access(gitPath);
				// Git exists at this path - it's installed but not in PATH yet
				return true;
			} catch {
			}
		}

		return false;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
