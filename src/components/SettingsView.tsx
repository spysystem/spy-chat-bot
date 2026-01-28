import {Fragment, useState, useEffect, JSX} from 'react';
import type {DatabaseConfig, GitHubConfig} from '../types';
import './SettingsView.css';

export function SettingsView(): JSX.Element {
	const [connection, setConnection]             = useState<DatabaseConfig | null>(null);
	const [isEditing, setIsEditing]               = useState<boolean>(false);
	const [testResult, setTestResult]             = useState<{ success: boolean; error?: string } | null>(null);
	const [apiKey, setApiKey]                     = useState('');
	const [apiKeyStatus, setApiKeyStatus]         = useState<'loading' | 'saved' | 'error' | 'none'>('loading');
	const [apiKeyError, setApiKeyError]           = useState<string>('');
	const [userName, setUserName]                 = useState('');
	const [userNameStatus, setUserNameStatus]     = useState<'loading' | 'saved' | 'error' | 'none'>('loading');
	const [autoTldr, setAutoTldr]                 = useState(false);
	const [autoTldrStatus, setAutoTldrStatus]     = useState<'loading' | 'saved' | 'error' | 'none'>('loading');
	const [githubConfig, setGithubConfig]         = useState<GitHubConfig>({
		token : '',
		owner : '',
		repo  : '',
		branch: 'main',
	});
	const [githubStatus, setGithubStatus]         = useState<'loading' | 'saved' | 'error' | 'none'>('loading');
	const [githubValidation, setGithubValidation] = useState<{
		testing: boolean;
		result?: { valid: boolean; error?: string; user?: string }
	}>({testing: false});
	const [appVersion, setAppVersion]             = useState<string>('');
	const [updateStatus, setUpdateStatus]         = useState<'checking' | 'available' | 'downloading' | 'ready' | 'none'>('none');
	const [updateInfo, setUpdateInfo]             = useState<{ version?: string; progress?: number; error?: string }>({});
	const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

	useEffect(() => {
		loadConnection();
		loadApiKey();
		loadUserName();
		loadAutoTldr();
		loadGitHubConfig();
		loadAppVersion();
	}, []);

	async function loadConnection(): Promise<void> {
		const configs = await window.electronAPI.getDatabaseConfigs();
		// Get the first (and only) connection
		if (configs.length > 0) {
			setConnection(configs[0]);
		} else {
			setConnection(null);
		}
	}

	async function loadApiKey(): Promise<void> {
		try {
			const key = await window.electronAPI.getApiKey();
			if (key) {
				setApiKey(key);
				setApiKeyStatus('saved');
			} else {
				setApiKeyStatus('none');
			}
		} catch (error) {
			console.error('Error loading API key:', error);
			setApiKeyStatus('error');
			setApiKeyError(error instanceof Error ? error.message : 'Unknown error');
		}
	}

	async function loadUserName(): Promise<void> {
		try {
			const name = await window.electronAPI.getUserName();
			if (name) {
				setUserName(name);
				setUserNameStatus('saved');
			} else {
				setUserNameStatus('none');
			}
		} catch (error) {
			console.error('Error loading user name:', error);
			setUserNameStatus('error');
		}
	}

	async function loadAutoTldr(): Promise<void> {
		try {
			const enabled = await window.electronAPI.getAutoTldr();
			setAutoTldr(enabled);
			setAutoTldrStatus('saved');
		} catch (error) {
			console.error('Error loading auto TL;DR:', error);
			setAutoTldrStatus('error');
		}
	}

	async function saveAutoTldrFunction(): Promise<void> {
		try {
			await window.electronAPI.saveAutoTldr(autoTldr);
			setAutoTldrStatus('saved');
			setTimeout(() => {
				setAutoTldrStatus('none');
			}, 2000);
		} catch (error) {
			console.error('Error saving auto TL;DR:', error);
			setAutoTldrStatus('error');
		}
	}


	function startEditing(): void {
		setIsEditing(true);
		setTestResult(null);
	}

	function cancelEditing(): void {
		setIsEditing(false);
		setTestResult(null);
		// Reload connection to reset any unsaved changes
		loadConnection();
	}

	async function testConnection(): Promise<void> {
		if (!connection) {
			return;
		}

		// Test connection without specific database
		const testConfig = {
			...connection,
			database: '',
		};

		const result = await window.electronAPI.testDatabaseConnection(testConfig);
		setTestResult(result);
	}

	async function saveConnection(): Promise<void> {
		if (!connection) {
			return;
		}

		// Always force read-only and set database to empty string
		const configToSave = {
			...connection,
			database: '',
			readOnly: true, // ALWAYS read-only - no writing allowed
		};

		await window.electronAPI.saveDatabaseConfig(configToSave);
		await loadConnection();
		setIsEditing(false);
		setTestResult(null);
	}

	async function loadGitHubConfig(): Promise<void> {
		try {
			const config = await window.electronAPI.getGitHubConfig();
			if (config) {
				setGithubConfig(config);
				setGithubStatus('saved');
			} else {
				setGithubStatus('none');
			}
		} catch (error) {
			console.error('Error loading GitHub config:', error);
			setGithubStatus('error');
		}
	}

	async function saveGitHubConfigFunction(): Promise<void> {
		try {
			await window.electronAPI.saveGitHubConfig(githubConfig);
			setGithubStatus('saved');
		} catch (error) {
			console.error('Error saving GitHub config:', error);
			setGithubStatus('error');
		}
	}

	async function testGitHubConnection(): Promise<void> {
		setGithubValidation({testing: true});
		try {
			const result = await window.electronAPI.validateGitHubConfig();
			setGithubValidation({testing: false, result});
		} catch (error) {
			console.error('Error testing GitHub connection:', error);
			setGithubValidation({testing: false, result: {valid: false, error: String(error)}});
		}
	}

	async function saveApiKeyFunction(): Promise<void> {
		try {
			setApiKeyError('');
			await window.electronAPI.saveApiKey(apiKey);
			setApiKeyStatus('saved');
		} catch (error) {
			console.error('Error saving API key:', error);
			setApiKeyStatus('error');
			setApiKeyError(error instanceof Error ? error.message : 'Failed to save API key');
		}
	}

	async function saveUserNameFunction(): Promise<void> {
		try {
			await window.electronAPI.saveUserName(userName);
			setUserNameStatus('saved');
		} catch (error) {
			console.error('Error saving user name:', error);
			setUserNameStatus('error');
		}
	}


	async function loadAppVersion(): Promise<void> {
		const version = await window.electronAPI.getAppVersion();
		setAppVersion(version);
	}

	async function checkForUpdates(): Promise<void> {
		setIsCheckingUpdate(true);
		setUpdateInfo({});
		try {
			const result = await window.electronAPI.checkForUpdates();
			if (result.error) {
				setUpdateInfo({ error: result.error });
			} else if (result.available) {
				setUpdateStatus('available');
				setUpdateInfo({ version: result.version });
			} else {
				setUpdateInfo({ version: result.currentVersion });
			}
		} catch (error) {
			setUpdateInfo({ error: String(error) });
		} finally {
			setIsCheckingUpdate(false);
		}
	}

	async function downloadUpdate(): Promise<void> {
		setUpdateStatus('downloading');
		setUpdateInfo((prev) => ({ ...prev, progress: 0 }));
		try {
			const result = await window.electronAPI.downloadUpdate();
			if (!result.success) {
				setUpdateInfo((prev) => ({ ...prev, error: result.error }));
				setUpdateStatus('none');
			}
		} catch (error) {
			setUpdateInfo((prev) => ({ ...prev, error: String(error) }));
			setUpdateStatus('none');
		}
	}

	function installUpdate(): void {
		window.electronAPI.installUpdate();
	}
	return (
		<div className="settings-view">
			<section className="settings-section">
				<h2>Personalization</h2>
				<div className="form-group">
					<label htmlFor="user-name">Your Name</label>
					<input
						id="user-name"
						type="text"
						value={userName}
						onChange={(event) => setUserName(event.target.value)}
						placeholder="Enter your name"
					/>
					<button onClick={saveUserNameFunction}>
						Save Name
					</button>
					{userNameStatus === 'saved' && (
						<span className="status success">✓ Saved</span>
					)}
					{userNameStatus === 'none' && (
						<span className="status error">⚠ Not configured</span>
					)}
					{userNameStatus === 'error' && (
						<span className="status error">⚠ Error saving</span>
					)}
				</div>
				<p className="help-text">
					This name will be displayed in your chat messages instead of "You"
				</p>
				<div className="form-group">
					<label htmlFor="auto-tldr">Auto TL;DR</label>
					<div className="checkbox-wrapper">
						<input
							id="auto-tldr"
							type="checkbox"
							checked={autoTldr}
							onChange={(event) => {
								setAutoTldr(event.target.checked);
								setAutoTldrStatus('none');
							}}
						/>
						<span className="checkbox-description">Always show TL;DR version by default</span>
					</div>
					<button onClick={saveAutoTldrFunction}>
						Save Auto TL;DR
					</button>
					{autoTldrStatus === 'saved' && (
						<span className="status success">✓ Saved</span>
					)}
					{autoTldrStatus === 'error' && (
						<span className="status error">⚠ Error saving</span>
					)}
				</div>
				<p className="help-text">
					When enabled, assistant responses will automatically be shown as short summaries (TL;DR). You can still toggle to see full
					answers.
				</p>
			</section>

			<section className="settings-section">
				<h2>Developer Tools</h2>
				<div className="form-group">
					<button
						onClick={async () => await window.electronAPI.openDebugWindow()}
					>
						🐛 Open Debug Console
					</button>
					<p className="help-text">
						Opens a separate window showing all database queries, API calls, and system activity in real-time
					</p>
				</div>
			</section>

			<section className="settings-section">
				<h2>Claude API Configuration</h2>
				<div className="form-group">
					<label htmlFor="api-key">API Key</label>
					<input
						id="api-key"
						type="password"
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						placeholder="sk-ant-..."
					/>
					<button onClick={saveApiKeyFunction}>
						Save API Key
					</button>
					{apiKeyStatus === 'saved' && (
						<span className="status success">✓ Saved</span>
					)}
					{apiKeyStatus === 'none' && (
						<span className="status error">⚠ Not configured</span>
					)}
					{apiKeyStatus === 'error' && (
						<span className="status error">⚠ Error: {apiKeyError}</span>
					)}
				</div>
				<p className="help-text">
					Get your API key from{' '}
					<a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer">
						console.anthropic.com
					</a>
				</p>
			</section>

			<section className="settings-section">
				<h2>GitHub Repository</h2>
				<p className="help-text" style={{marginBottom: '20px'}}>
					Connect to your GitHub repository to let Claude read and search your code.
					Create a Personal Access Token at{' '}
					<a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer">
						github.com/settings/tokens
					</a>
					{' '}with "repo" scope.
				</p>

				<div className="form-group">
					<label htmlFor="github-token">GitHub Token</label>
					<input
						id="github-token"
						type="password"
						value={githubConfig.token}
						onChange={(event) => setGithubConfig({...githubConfig, token: event.target.value})}
						placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
					/>
				</div>

				<div className="form-row">
					<div className="form-group">
						<label htmlFor="github-owner">Repository Owner</label>
						<input
							id="github-owner"
							type="text"
							value={githubConfig.owner}
							onChange={(event) => setGithubConfig({...githubConfig, owner: event.target.value})}
							placeholder="your-organization"
						/>
					</div>

					<div className="form-group">
						<label htmlFor="github-repo">Repository Name</label>
						<input
							id="github-repo"
							type="text"
							value={githubConfig.repo}
							onChange={(event) => setGithubConfig({...githubConfig, repo: event.target.value})}
							placeholder="your-repo"
						/>
					</div>
				</div>

				<div className="form-group">
					<label htmlFor="github-branch">Branch</label>
					<input
						id="github-branch"
						type="text"
						value={githubConfig.branch}
						onChange={(event) => setGithubConfig({...githubConfig, branch: event.target.value})}
						placeholder="main"
					/>
				</div>
				<p className="help-text">
					Standard branch til GitHub søgninger. Kan overskrives midlertidigt når du åbner chatten fra SPY systemet.
				</p>

				<div className="form-group">
					<button onClick={saveGitHubConfigFunction}>
						Save GitHub Configuration
					</button>
					<button onClick={testGitHubConnection} disabled={githubValidation.testing}>
						{githubValidation.testing ? '⏳ Testing...' : '🔍 Test Connection'}
					</button>
					{githubStatus === 'saved' && (
						<span className="status success">✓ Saved</span>
					)}
					{githubStatus === 'none' && (
						<span className="status error">⚠ Not configured</span>
					)}
					{githubStatus === 'error' && (
						<span className="status error">⚠ Error saving</span>
					)}
			{githubValidation.result && (
				<div className="form-group">
					{githubValidation.result.valid ? (
						<div className="status success">
							✓ Connection successful! Authenticated as: {githubValidation.result.user}
						</div>
					) : (
						<div className="status error">
							⚠ Connection failed: {githubValidation.result.error}
						</div>
					)}
				</div>
			)}
				</div>
			</section>

			<section className="settings-section">
				<h2>Database Connection</h2>
				<p className="help-text" style={{marginBottom: '12px'}}>
					Configure your database connection details. You'll specify the database name in each chat.
				</p>
				<p className="help-text" style={{marginBottom: '20px', color: 'var(--success-color)', fontWeight: 'bold'}}>
					⚠️ All database operations are READ-ONLY. Write operations are NEVER permitted.
				</p>

				{!connection && !isEditing && (
					<p className="empty-state">No connection configured. Please configure a connection below.</p>
				)}

				{connection && !isEditing && (
					<div className="database-card">
						<div className="database-info">
							<h3>{connection.name}</h3>
							<p>{connection.host}:{connection.port.toString()}</p>
							<span className="badge">Read-only</span>
						</div>
						<div className="database-actions">
							<button onClick={startEditing}>Edit</button>
						</div>
					</div>
				)}

				{(!connection || isEditing) && (
					<div className="database-form">
						<h3>{connection ? 'Edit Connection' : 'Configure Connection'}</h3>

						<div className="form-group">
							<label htmlFor="db-name">Connection Name</label>
							<input
								id="db-name"
								type="text"
								value={connection?.name || ''}
								onChange={(event) =>
									setConnection({
										...(connection || {
											id      : crypto.randomUUID(),
											host    : 'localhost',
											port    : 3306,
											database: '',
											username: 'root',
											password: '',
											readOnly: true, // ALWAYS read-only
										}), name: event.target.value,
									})
								}
								placeholder="Production Server"
							/>
						</div>

						<div className="form-row">
							<div className="form-group">
								<label htmlFor="db-host">Host</label>
								<input
									id="db-host"
									type="text"
									value={connection?.host || 'localhost'}
									onChange={(event) =>
										setConnection({
											...(connection || {
												id      : crypto.randomUUID(),
												name    : '',
												port    : 3306,
												database: '',
												username: 'root',
												password: '',
												readOnly: true,
											}), host: event.target.value,
										})
									}
									placeholder="localhost"
								/>
							</div>

							<div className="form-group">
								<label htmlFor="db-port">Port</label>
								<input
									id="db-port"
									type="number"
									value={connection?.port.toString() || '3306'}
									onChange={(event) =>
										setConnection({
											...(connection || {
												id      : crypto.randomUUID(),
												name    : '',
												host    : 'localhost',
												database: '',
												username: 'root',
												password: '',
												readOnly: true,
											}), port: Number.parseInt(event.target.value),
										})
									}
									placeholder="3306"
								/>
							</div>
						</div>

						<div className="form-group">
							<label htmlFor="db-username">Username</label>
							<input
								id="db-username"
								type="text"
								value={connection?.username || ''}
								onChange={(event) =>
									setConnection({
										...(connection || {
											id      : crypto.randomUUID(),
											name    : '',
											host    : 'localhost',
											port    : 3306,
											database: '',
											password: '',
											readOnly: true,
										}), username: event.target.value,
									})
								}
								placeholder="root"
							/>
						</div>

						<div className="form-group">
							<label htmlFor="db-password">Password</label>
							<input
								id="db-password"
								type="password"
								value={connection?.password || ''}
								onChange={(event) =>
									setConnection({
										...(connection || {
											id      : crypto.randomUUID(),
											name    : '',
											host    : 'localhost',
											port    : 3306,
											database: '',
											username: 'root',
											readOnly: true,
										}), password: event.target.value,
									})
								}
								placeholder="••••••••"
							/>
						</div>


						{testResult && (
							<div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
								{testResult.success ? (
									<Fragment>✓ Connection successful</Fragment>
								) : (
									<Fragment>✗ Connection failed: {testResult.error}</Fragment>
								)}
							</div>
						)}

						<div className="form-actions">
							{connection && isEditing && (
								<button onClick={cancelEditing} className="secondary">
									Cancel
								</button>
							)}
							<button onClick={testConnection}>Test Connection</button>
							<button onClick={saveConnection} disabled={!testResult?.success}>
								Save
							</button>
						</div>
					</div>
				)}
			</section>

			<section className="settings-section">
				<h2>Updates & About</h2>
				<div className="form-group">
					<label>Current Version</label>
					<div className="version-info">
						<span className="version-number">v{appVersion || 'Loading...'}</span>
					</div>
				</div>

				<div className="form-group">
					<button
						onClick={checkForUpdates}
						disabled={isCheckingUpdate || updateStatus === 'downloading'}
					>
						{isCheckingUpdate ? '⏳ Checking...' : '🔍 Check for Updates'}
					</button>

					{updateStatus === 'available' && updateInfo.version && (
						<div className="update-available">
							<p>✨ New version available: v{updateInfo.version}</p>
							<button onClick={downloadUpdate}>
								📥 Download Update
							</button>
						</div>
					)}

					{updateStatus === 'downloading' && (
						<div className="update-downloading">
							<p>⏬ Downloading update... {updateInfo.progress || 0}%</p>
						</div>
					)}

					{updateStatus === 'ready' && (
						<div className="update-ready">
							<p>✅ Update downloaded and ready to install</p>
							<button onClick={installUpdate} className="install-button">
								🚀 Restart and Install
							</button>
						</div>
					)}

					{updateStatus === 'none' && !isCheckingUpdate && updateInfo.version && !updateInfo.error && (
						<div className="update-current">
							<p>✓ You are running the latest version</p>
						</div>
					)}

					{updateInfo.error && (
						<div className="update-error">
							<p>⚠ Error: {updateInfo.error}</p>
						</div>
					)}
				</div>

				<div className="form-group">
					<p className="help-text">
						Spørge Jørgen automatically checks for updates when you start the app.
						Updates are downloaded in the background and installed when you restart.
					</p>
				</div>
			</section>
		</div>
	);
}
