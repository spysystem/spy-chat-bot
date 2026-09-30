import {JSX, useEffect, useState} from 'react';
import type {
	AiQualityProfile,
	DatabaseConfig,
	GitHubConfig,
	LocalRepoStatus,
	LocalRepoSyncProgress,
	SchemaIndexProgress,
	SchemaIndexStatus,
} from '../types';
import './SettingsView.css';
import {SentrySettings} from './SentrySettings';
import {SettingsSection, StatusText} from './SettingsSection';
import {Icon, type IconName} from './Icon';
import {LANGUAGES, type TranslationKey, useI18n} from '../i18n';

export function SettingsView(): JSX.Element {
	const {t, language, setLanguage, locale} = useI18n();
	const [connection, setConnection]                           = useState<DatabaseConfig | null>(null);
	const [isEditing, setIsEditing]                             = useState<boolean>(false);
	const [testResult, setTestResult]                           = useState<{ success: boolean; error?: string } | null>(null);
	const [schemaIndexDatabaseName, setSchemaIndexDatabaseName] = useState<string>('');
	const [schemaIndexBranch, setSchemaIndexBranch]             = useState<string>('');
	const [schemaIndexStatus, setSchemaIndexStatus]             = useState<SchemaIndexStatus | null>(null);
	const [schemaIndexProgress, setSchemaIndexProgress]         = useState<SchemaIndexProgress | null>(null);
	const [schemaIndexError, setSchemaIndexError]               = useState<string>('');
	const [isGeneratingSchemaIndex, setIsGeneratingSchemaIndex] = useState<boolean>(false);
	const [apiKey, setApiKey]                                   = useState('');
	const [apiKeyStatus, setApiKeyStatus]                       = useState<'loading' | 'saved' | 'error' | 'none'>('loading');
	const [apiKeyError, setApiKeyError]                         = useState<string>('');
	const [aiQualityProfile, setAiQualityProfile]               = useState<AiQualityProfile>('maximum_accuracy');
	const [userName, setUserName]                               = useState('');
	const [userNameStatus, setUserNameStatus]                   = useState<'loading' | 'saved' | 'error' | 'none'>('loading');
	const [githubConfig, setGithubConfig]                       = useState<GitHubConfig>({
		token : '',
		owner : '',
		repo  : '',
		branch: 'main',
	});
	const [githubStatus, setGithubStatus]                       = useState<'loading' | 'saved' | 'error' | 'none'>('loading');
	const [githubValidation, setGithubValidation]               = useState<{
		testing: boolean;
		result?: { valid: boolean; error?: string; user?: string }
	}>({testing: false});
	const [localRepoUrl, setLocalRepoUrl]                       = useState<string>('https://github.com/repo-owner/repo-name.git');
	const [localRepoStatus, setLocalRepoStatus]                 = useState<LocalRepoStatus | null>(null);
	const [localRepoSyncing, setLocalRepoSyncing]               = useState<boolean>(false);
	const [localRepoError, setLocalRepoError]                   = useState<string>('');
	const [localRepoMessage, setLocalRepoMessage]               = useState<string>('');
	const [localRepoProgress, setLocalRepoProgress]             = useState<LocalRepoSyncProgress | null>(null);
	const [repoBranches, setRepoBranches]                       = useState<string[]>([]);
	const [appVersion, setAppVersion]                           = useState<string>('');
	const [updateStatus, setUpdateStatus]                       = useState<'checking' | 'available' | 'downloading' | 'ready' | 'none'>('none');
	const [updateInfo, setUpdateInfo]                           = useState<{ version?: string; progress?: number; error?: string }>({});
	const [isCheckingUpdate, setIsCheckingUpdate]               = useState(false);

	useEffect(() => {
		loadConnection();
		loadApiKey();
		loadAiQualityProfile();
		loadUserName();
		loadGitHubConfig();
		loadLocalRepoStatus();
		loadAppVersion();

		// Setup update event listeners
		const unsubscribeSchemaProgress = window.electronAPI.onSchemaIndexProgress((progress) => {
			setSchemaIndexProgress(progress);
		});
		const unsubscribeSchemaComplete = window.electronAPI.onSchemaIndexComplete((status) => {
			setSchemaIndexStatus(status);
			setIsGeneratingSchemaIndex(false);
			// Keep progress visible briefly so users can see completion.
			setSchemaIndexProgress((prev) => {
				if (!prev) {
					return {stage: 'Completed', done: 1, total: 1};
				}
				return {stage: 'Completed', done: prev.total, total: prev.total};
			});
			setTimeout(() => {
				setSchemaIndexProgress(null);
			}, 1500);
		});
		const unsubscribeSchemaError    = window.electronAPI.onSchemaIndexError((error) => {
			setSchemaIndexError(error);
			setIsGeneratingSchemaIndex(false);
		});

		const unsubscribeUpdateAvailable = window.electronAPI.onUpdateAvailable((info) => {
			setUpdateStatus('available');
			setUpdateInfo({version: info.version});
		});

		const unsubscribeDownloadProgress = window.electronAPI.onUpdateDownloadProgress((progress) => {
			setUpdateStatus('downloading');
			setUpdateInfo((prev) => ({...prev, progress: Math.round(progress.percent)}));
		});

		const unsubscribeUpdateDownloaded = window.electronAPI.onUpdateDownloaded(() => {
			setUpdateStatus('ready');
			setUpdateInfo((prev) => ({...prev, progress: 100}));
		});

		const unsubscribeUpdateError = window.electronAPI.onUpdateError((error) => {
			setUpdateInfo((prev) => ({...prev, error}));
			setUpdateStatus('none');
		});

		const unsubscribeLocalRepoProgress = window.electronAPI.onLocalRepoSyncProgress((progress) => {
			setLocalRepoProgress(progress);
		});

		// Cleanup listeners on unmount
		return () => {
			unsubscribeSchemaProgress();
			unsubscribeSchemaComplete();
			unsubscribeSchemaError();
			unsubscribeUpdateAvailable();
			unsubscribeDownloadProgress();
			unsubscribeUpdateDownloaded();
			unsubscribeUpdateError();
			unsubscribeLocalRepoProgress();
		};
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

	async function refreshSchemaIndexStatus(): Promise<void> {
		setSchemaIndexError('');
		setSchemaIndexStatus(null);
		if (!connection) {
			return;
		}
		try {
			const status = await window.electronAPI.getSchemaIndexStatus(connection.id, schemaIndexBranch.trim() || undefined);
			setSchemaIndexStatus(status);
		} catch (error) {
			setSchemaIndexError(error instanceof Error ? error.message : String(error));
		}
	}

	async function generateSchemaIndex(): Promise<void> {
		setSchemaIndexError('');
		setSchemaIndexProgress({stage: 'Starting...', done: 0, total: 1});

		if (!connection) {
			setSchemaIndexError(t('settings.schema.noConn'));
			return;
		}
		const dbName = schemaIndexDatabaseName.trim();
		if (!dbName) {
			setSchemaIndexError(t('settings.schema.noDb'));
			return;
		}

		setIsGeneratingSchemaIndex(true);
		try {
			const status = await window.electronAPI.generateSchemaIndex(connection.id, dbName, schemaIndexBranch.trim() || undefined);
			setSchemaIndexStatus(status);
		} catch (error) {
			setSchemaIndexError(error instanceof Error ? error.message : String(error));
		} finally {
			setIsGeneratingSchemaIndex(false);
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

	async function loadAiQualityProfile(): Promise<void> {
		try {
			const profile = await window.electronAPI.getAiQualityProfile();
			setAiQualityProfile(profile || 'maximum_accuracy');
		} catch (error) {
			console.error('Error loading AI quality profile:', error);
		}
	}

	async function saveAiQualityProfileFunction(profile: AiQualityProfile): Promise<void> {
		setAiQualityProfile(profile);
		await window.electronAPI.saveAiQualityProfile(profile);
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
				setSchemaIndexBranch((prev) => prev.trim() !== '' ? prev : (config.branch || ''));
				setGithubStatus('saved');
			} else {
				setGithubStatus('none');
			}
		} catch (error) {
			console.error('Error loading GitHub config:', error);
			setGithubStatus('error');
		}
	}

	async function loadLocalRepoStatus(): Promise<void> {
		try {
			const status = await window.electronAPI.getLocalRepoStatus();
			setLocalRepoStatus(status);
			if (status.url) {
				setLocalRepoUrl(status.url);
			}
			if (status.exists) {
				setRepoBranches(await window.electronAPI.listRepoBranches());
			}
		} catch (error) {
			console.error('Error loading local repo status:', error);
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

	async function syncLocalRepo(): Promise<void> {
		setLocalRepoError('');
		setLocalRepoMessage('');
		setLocalRepoSyncing(true);
		setLocalRepoProgress({stage: t('settings.sync.starting')});
		try {
			const result = await window.electronAPI.syncLocalRepo(localRepoUrl);
			if (!result.success) {
				setLocalRepoError(result.error || t('settings.sync.failed'));
			} else {
				setLocalRepoMessage(t('settings.sync.success'));
				await loadLocalRepoStatus();
			}
		} catch (error) {
			setLocalRepoError(error instanceof Error ? error.message : String(error));
		} finally {
			setLocalRepoSyncing(false);
			setTimeout(() => {
				setLocalRepoProgress(null);
			}, 2000);
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
			setApiKeyError(error instanceof Error ? error.message : t('settings.ai.saveFailed'));
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
				setUpdateInfo({error: result.error});
			} else if (result.available) {
				setUpdateStatus('available');
				setUpdateInfo({version: result.version});
			} else {
				setUpdateInfo({version: result.currentVersion});
			}
		} catch (error) {
			setUpdateInfo({error: String(error)});
		} finally {
			setIsCheckingUpdate(false);
		}
	}

	async function downloadUpdate(): Promise<void> {
		setUpdateStatus('downloading');
		setUpdateInfo((prev) => ({...prev, progress: 0}));
		try {
			const result = await window.electronAPI.downloadUpdate();
			if (!result.success) {
				setUpdateInfo((prev) => ({...prev, error: result.error}));
				setUpdateStatus('none');
			}
		} catch (error) {
			setUpdateInfo((prev) => ({...prev, error: String(error)}));
			setUpdateStatus('none');
		}
	}

	function installUpdate(): void {
		window.electronAPI.installUpdate();
	}

	function scrollToSection(id: string): void {
		document.getElementById(id)?.scrollIntoView({behavior: 'smooth', block: 'start'});
	}

	return (
		<div className="settings-view">
			<nav className="settings-nav">
				<div className="settings-nav-title">{t('settings.title')}</div>
				{SETTINGS_NAV.map((item) => (
					<button key={item.id} onClick={() => scrollToSection(item.id)}>
						<Icon name={item.icon} size={15}/>
						{t(item.label)}
					</button>
				))}
			</nav>

			<div className="settings-content">
				<header className="settings-header">
					<h1>{t('settings.title')}</h1>
					<p>{t('settings.intro')}</p>
				</header>

				<SettingsSection id="settings-profile" title={t('settings.profile.title')} description={t('settings.profile.desc')}>
					<div className="form-group">
						<label htmlFor="user-name">{t('settings.profile.name')}</label>
						<div className="input-row">
							<input
								id="user-name"
								type="text"
								value={userName}
								onChange={(event) => setUserName(event.target.value)}
								onKeyDown={(event) => event.key === 'Enter' && saveUserNameFunction()}
								placeholder={t('settings.profile.namePh')}
							/>
							<button className="btn btn-primary" onClick={saveUserNameFunction}>{t('common.save')}</button>
						</div>
						{userNameStatus === 'saved' && <StatusText ok>{t('common.saved')}</StatusText>}
						{userNameStatus === 'none' && <StatusText ok={false}>{t('settings.profile.notSet')}</StatusText>}
						{userNameStatus === 'error' && <StatusText ok={false}>{t('settings.profile.saveErr')}</StatusText>}
					</div>

					<div className="form-group">
						<label>{t('settings.profile.language')}</label>
						<div className="segmented" role="radiogroup" aria-label={t('settings.profile.language')}>
							{LANGUAGES.map((option) => (
								<button
									key={option.value}
									type="button"
									role="radio"
									aria-checked={language === option.value}
									className={language === option.value ? 'active' : ''}
									onClick={() => setLanguage(option.value)}
								>
									{option.label}
								</button>
							))}
						</div>
					</div>
				</SettingsSection>

				<SettingsSection id="settings-ai" title={t('settings.ai.title')} description={t('settings.ai.desc')}>
					<div className="form-group">
						<label htmlFor="api-key">{t('settings.ai.key')}</label>
						<div className="input-row">
							<input
								id="api-key"
								type="password"
								value={apiKey}
								onChange={(event) => setApiKey(event.target.value)}
								placeholder="sk-ant-..."
							/>
							<button className="btn btn-primary" onClick={saveApiKeyFunction}>{t('common.save')}</button>
						</div>
						{apiKeyStatus === 'saved' && <StatusText ok>{t('common.saved')}</StatusText>}
						{apiKeyStatus === 'none' && <StatusText ok={false}>{t('settings.ai.keyMissing')}</StatusText>}
						{apiKeyStatus === 'error' && <StatusText ok={false}>{t('settings.ai.keyError', {error: apiKeyError})}</StatusText>}
						<p className="help-text">
							{t('settings.ai.keyHelp')}{' '}
							<a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer">console.anthropic.com</a>
						</p>
					</div>

					<div className="form-group">
						<label>{t('settings.ai.quality')}</label>
						<div className="choice-cards">
							{QUALITY_OPTIONS.map((option) => (
								<label key={option.value} className={`choice-card ${aiQualityProfile === option.value ? 'selected' : ''}`}>
									<input
										type="radio"
										name="ai-quality-profile"
										value={option.value}
										checked={aiQualityProfile === option.value}
										onChange={() => saveAiQualityProfileFunction(option.value)}
									/>
									<span className="choice-card-title">{t(option.title)}</span>
									<span className="choice-card-description">{t(option.description)}</span>
								</label>
							))}
						</div>
					</div>
				</SettingsSection>

				<SettingsSection
					id="settings-database"
					title={t('settings.db.title')}
					description={t('settings.db.desc')}
				>
					<div className="notice success">
						<Icon name="check" size={15}/>
						{t('settings.db.readOnly')}
					</div>

					{connection && !isEditing && (
						<div className="database-card">
							<span className="database-card-icon"><Icon name="database" size={18}/></span>
							<div className="database-info">
								<h3>{connection.name}</h3>
								<p>{connection.host}:{connection.port.toString()}</p>
							</div>
							<span className="badge">{t('settings.db.badge')}</span>
							<button className="btn" onClick={startEditing}>{t('settings.db.edit')}</button>
						</div>
					)}

					{(!connection || isEditing) && (
						<div className="database-form">
							<div className="form-group">
								<label htmlFor="db-name">{t('settings.db.name')}</label>
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
									<label htmlFor="db-host">{t('settings.db.host')}</label>
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
									<label htmlFor="db-port">{t('settings.db.port')}</label>
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

							<div className="form-row even">
								<div className="form-group">
									<label htmlFor="db-username">{t('settings.db.username')}</label>
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
									<label htmlFor="db-password">{t('settings.db.password')}</label>
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
							</div>

							{testResult && (
								<div className={`notice ${testResult.success ? 'success' : 'error'}`}>
									{testResult.success ? t('settings.db.testOk') : t('settings.db.testFailed', {error: testResult.error ?? ''})}
								</div>
							)}

							<div className="form-actions">
								<button className="btn" onClick={testConnection}>{t('common.testConnection')}</button>
								<button className="btn btn-primary" onClick={saveConnection} disabled={!testResult?.success}
								        title={testResult?.success ? undefined : t('settings.db.testFirst')}>
									{t('common.save')}
								</button>
								{connection && isEditing && (
									<button className="btn btn-ghost" onClick={cancelEditing}>{t('common.cancel')}</button>
								)}
							</div>
						</div>
					)}

					{connection && !isEditing && (
						<div className="subsection">
							<h3>{t('settings.schema.title')} <span className="tag">{t('settings.schema.tag')}</span></h3>
							<p className="help-text">
								{t('settings.schema.desc')}
							</p>

							<div className="form-row even">
								<div className="form-group">
									<label htmlFor="schema-index-database-name">{t('settings.schema.database')}</label>
									<input
										id="schema-index-database-name"
										type="text"
										value={schemaIndexDatabaseName}
										onChange={(event) => {
											setSchemaIndexDatabaseName(event.target.value);
											setSchemaIndexStatus(null);
											setSchemaIndexError('');
										}}
										onBlur={refreshSchemaIndexStatus}
										placeholder={t('settings.schema.dbPh')}
									/>
								</div>

								<div className="form-group">
									<label htmlFor="schema-index-branch">{t('settings.schema.branch')}</label>
									<input
										id="schema-index-branch"
										type="text"
										value={schemaIndexBranch}
										onChange={(event) => {
											setSchemaIndexBranch(event.target.value);
											setSchemaIndexStatus(null);
											setSchemaIndexError('');
										}}
										onBlur={refreshSchemaIndexStatus}
										placeholder={t('settings.schema.branchPh')}
										list="repo-branches"
									/>
									<datalist id="repo-branches">
										{repoBranches.map((branch) => <option key={branch} value={branch}/>)}
									</datalist>
								</div>
							</div>

							<div className="form-actions">
								<button
									className="btn btn-primary"
									onClick={generateSchemaIndex}
									disabled={isGeneratingSchemaIndex || !schemaIndexDatabaseName.trim()}
								>
									{isGeneratingSchemaIndex ? t('settings.schema.running') : t('settings.schema.generate')}
								</button>
								{schemaIndexStatus?.exists && schemaIndexStatus.generatedAtIso && (
									<StatusText ok>{t('settings.schema.indexed', {count: schemaIndexStatus.tableCount ?? 0, source: schemaIndexStatus.source ?? ''})}</StatusText>
								)}
							</div>

							{schemaIndexProgress && (
								<ProgressBar
									label={schemaIndexProgress.stage}
									detail={schemaIndexProgress.total > 1 ? `${schemaIndexProgress.done}/${schemaIndexProgress.total}` : ''}
									percent={schemaIndexProgress.total > 0 ? (schemaIndexProgress.done / schemaIndexProgress.total) * 100 : 0}
								/>
							)}

							{schemaIndexError && (
								<div className="notice error">⚠ {schemaIndexError}</div>
							)}

							{schemaIndexStatus && schemaIndexDatabaseName.trim() && (
								<dl className="key-values">
									<dt>{t('settings.schema.status')}</dt>
									<dd>{schemaIndexStatus.exists ? t('settings.schema.available') : t('settings.schema.missing')}</dd>
									<dt>{t('settings.schema.requested')}</dt>
									<dd>{schemaIndexStatus.requestedBranch || t('settings.schema.global')}</dd>
									{schemaIndexStatus.exists && (
										<>
											<dt>{t('settings.schema.resolved')}</dt>
											<dd>{schemaIndexStatus.branch || t('settings.schema.global')}{schemaIndexStatus.fallbackUsed ? t('settings.schema.fallback') : ''}</dd>
										</>
									)}
									{schemaIndexStatus.generatedAtIso && (
										<>
											<dt>{t('settings.schema.generated')}</dt>
											<dd>{new Date(schemaIndexStatus.generatedAtIso).toLocaleString(locale)}</dd>
										</>
									)}
									<dt>{t('settings.schema.path')}</dt>
									<dd><code>{schemaIndexStatus.filePath}</code></dd>
								</dl>
							)}
						</div>
					)}
				</SettingsSection>

				<SettingsSection
					id="settings-github"
					title={t('settings.github.title')}
					description={
						<>
							{t('settings.github.desc1')}{' '}
							<a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer">github.com/settings/tokens</a>
							{' '}{t('settings.github.desc2')}
						</>
					}
				>
					<div className="form-group">
						<label htmlFor="github-token">{t('settings.github.token')}</label>
						<input
							id="github-token"
							type="password"
							value={githubConfig.token}
							onChange={(event) => setGithubConfig({...githubConfig, token: event.target.value})}
							placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
						/>
					</div>

					<div className="form-row even">
						<div className="form-group">
							<label htmlFor="github-owner">{t('settings.github.owner')}</label>
							<input
								id="github-owner"
								type="text"
								value={githubConfig.owner}
								onChange={(event) => setGithubConfig({...githubConfig, owner: event.target.value})}
								placeholder="your-organization"
							/>
						</div>

						<div className="form-group">
							<label htmlFor="github-repo">{t('settings.github.repo')}</label>
							<input
								id="github-repo"
								type="text"
								value={githubConfig.repo}
								onChange={(event) => setGithubConfig({...githubConfig, repo: event.target.value})}
								placeholder="your-repo"
							/>
						</div>
					</div>

					<div className="form-actions">
						<button className="btn btn-primary" onClick={saveGitHubConfigFunction}>{t('common.save')}</button>
						<button className="btn" onClick={testGitHubConnection} disabled={githubValidation.testing}>
							{githubValidation.testing ? t('common.testing') : t('common.testConnection')}
						</button>
						{githubStatus === 'saved' && !githubValidation.result && <StatusText ok>{t('common.saved')}</StatusText>}
						{githubStatus === 'none' && <StatusText ok={false}>{t('settings.github.missing')}</StatusText>}
						{githubStatus === 'error' && <StatusText ok={false}>{t('settings.github.saveErr')}</StatusText>}
						{githubValidation.result && (githubValidation.result.valid
							? <StatusText ok>{t('settings.github.connected', {user: githubValidation.result.user ?? ''})}</StatusText>
							: <StatusText ok={false}>⚠ {githubValidation.result.error}</StatusText>)}
					</div>
				</SettingsSection>

				<SettingsSection
					id="settings-git-sync"
					title={t('settings.sync.title')}
					description={t('settings.sync.desc')}
				>
					<div className="form-group">
						<label htmlFor="local-repo-url">{t('settings.sync.url')}</label>
						<input
							id="local-repo-url"
							type="text"
							value={localRepoUrl}
							onChange={(event) => setLocalRepoUrl(event.target.value)}
							placeholder="https://github.com/repo-owner/repo-name.git"
						/>
					</div>

					<div className="form-actions">
						<button className="btn btn-primary" onClick={syncLocalRepo} disabled={localRepoSyncing}>
							<Icon name="refresh" size={14}/>
							{localRepoSyncing ? t('settings.sync.syncing') : t('settings.sync.sync')}
						</button>
						<button className="btn" onClick={loadLocalRepoStatus} disabled={localRepoSyncing}>{t('settings.sync.refresh')}</button>
						{localRepoMessage && <StatusText ok>✓ {localRepoMessage}</StatusText>}
						{localRepoError && <StatusText ok={false}>⚠ {localRepoError}</StatusText>}
					</div>

					{localRepoProgress && (
						<ProgressBar
							label={localRepoProgress.stage}
							detail={typeof localRepoProgress.percent === 'number' ? `${localRepoProgress.percent}%` : ''}
							percent={localRepoProgress.percent ?? 0}
						/>
					)}

					{localRepoStatus && (localRepoStatus.exists ? (
						<div className="subsection">
							<dl className="key-values">
								<dt>{t('settings.schema.status')}</dt>
								<dd className="ok">{t('settings.sync.ready')}</dd>
								<dt>{t('settings.sync.default')}</dt>
								<dd>{localRepoStatus.defaultBranch || t('settings.sync.unknown')}</dd>
								{localRepoStatus.lastFetchIso && (
									<>
										<dt>{t('settings.sync.lastFetch')}</dt>
										<dd>{new Date(localRepoStatus.lastFetchIso).toLocaleString(locale)}</dd>
									</>
								)}
								<dt>{t('settings.sync.location')}</dt>
								<dd><code>{localRepoStatus.repoPath}</code></dd>
							</dl>
							{localRepoStatus.worktrees.length > 0 && (
								<table className="settings-table">
									<thead>
									<tr>
										<th>{t('settings.sync.branch')}</th>
										<th>{t('settings.sync.commit')}</th>
										<th>{t('settings.sync.updated')}</th>
										<th>{t('settings.sync.lastUsed')}</th>
									</tr>
									</thead>
									<tbody>
									{localRepoStatus.worktrees.map((worktree) => (
										<tr key={worktree.branch}>
											<td>{worktree.branch}</td>
											<td><code>{worktree.commit || '?'}</code></td>
											<td>{new Date(worktree.lastSyncIso).toLocaleString(locale)}</td>
											<td>{new Date(worktree.lastUsedIso).toLocaleString(locale)}</td>
										</tr>
									))}
									</tbody>
								</table>
							)}
						</div>
					) : (
						<div className="notice warning">{t('settings.sync.notSynced')}</div>
					))}
				</SettingsSection>

				<SentrySettings/>

				<SettingsSection
					id="settings-updates"
					title={t('settings.updates.title')}
					description={t('settings.updates.desc')}
				>
					<div className="version-row">
						<div>
							<div className="version-label">{t('settings.updates.current')}</div>
							<div className="version-number">v{appVersion || '…'}</div>
						</div>
						<button
							className="btn"
							onClick={checkForUpdates}
							disabled={isCheckingUpdate || updateStatus === 'downloading'}
						>
							<Icon name="refresh" size={14}/>
							{isCheckingUpdate ? t('settings.updates.checking') : t('settings.updates.check')}
						</button>
					</div>

					{updateStatus === 'available' && updateInfo.version && (
						<div className="notice info">
							<span>{t('settings.updates.new')} <strong>v{updateInfo.version}</strong></span>
							<button className="btn btn-primary" onClick={downloadUpdate}>
								<Icon name="download" size={14}/>
								{t('settings.updates.download')}
							</button>
						</div>
					)}

					{updateStatus === 'downloading' && (
						<ProgressBar label={t('settings.updates.progress')} detail={`${updateInfo.progress || 0}%`} percent={updateInfo.progress || 0}/>
					)}

					{updateStatus === 'ready' && (
						<div className="notice success">
							<span>{t('settings.updates.ready')}</span>
							<button className="btn btn-primary" onClick={installUpdate}>{t('settings.updates.install')}</button>
						</div>
					)}

					{updateStatus === 'none' && !isCheckingUpdate && updateInfo.version && !updateInfo.error && (
						<div className="notice success">{t('settings.updates.latest')}</div>
					)}

					{updateInfo.error && (
						<div className="notice error">⚠ {updateInfo.error}</div>
					)}
				</SettingsSection>

				<SettingsSection
					id="settings-developer"
					title={t('settings.dev.title')}
					description={t('settings.dev.desc')}
				>
					<button className="btn" onClick={async () => await window.electronAPI.openDebugWindow()}>
						<Icon name="bug" size={15}/>
						{t('settings.dev.open')}
					</button>
				</SettingsSection>
			</div>
		</div>
	);
}

const SETTINGS_NAV: Array<{ id: string; label: TranslationKey; icon: IconName }> = [
	{id: 'settings-profile', label: 'settings.nav.profile', icon: 'message'},
	{id: 'settings-ai', label: 'settings.nav.ai', icon: 'settings'},
	{id: 'settings-database', label: 'settings.nav.database', icon: 'database'},
	{id: 'settings-github', label: 'settings.nav.github', icon: 'gitBranch'},
	{id: 'settings-git-sync', label: 'settings.nav.gitSync', icon: 'refresh'},
	{id: 'settings-sentry', label: 'settings.nav.sentry', icon: 'alert'},
	{id: 'settings-updates', label: 'settings.nav.updates', icon: 'download'},
	{id: 'settings-developer', label: 'settings.nav.developer', icon: 'bug'},
];

const QUALITY_OPTIONS: Array<{ value: AiQualityProfile; title: TranslationKey; description: TranslationKey }> = [
	{value: 'balanced', title: 'settings.ai.balanced', description: 'settings.ai.balancedDesc'},
	{value: 'maximum_accuracy', title: 'settings.ai.max', description: 'settings.ai.maxDesc'},
];

function ProgressBar({label, detail, percent}: { label: string; detail?: string; percent: number }): JSX.Element {
	return (
		<div className="progress">
			<div className="progress-row">
				<span>{label}</span>
				{detail && <span className="progress-detail">{detail}</span>}
			</div>
			<div className="progress-track">
				<div className="progress-fill" style={{width: `${Math.min(100, Math.max(0, percent))}%`}}/>
			</div>
		</div>
	);
}
