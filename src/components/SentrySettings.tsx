import {JSX, useEffect, useState} from 'react';

export function SentrySettings(): JSX.Element {
	const [token, setToken]         = useState('');
	const [orgSlug, setOrgSlug]     = useState('spy-aps');
	const [baseUrl, setBaseUrl]     = useState('https://us.sentry.io');
	const [hasToken, setHasToken]   = useState(false);
	const [status, setStatus]       = useState<{ ok: boolean; text: string } | null>(null);
	const [isTesting, setIsTesting] = useState(false);

	useEffect(() => {
		void window.electronAPI.getSentryConfig().then((config) => {
			setHasToken(config.hasToken);
			setOrgSlug(config.orgSlug);
			setBaseUrl(config.baseUrl);
		});
	}, []);

	async function save(): Promise<void> {
		try {
			await window.electronAPI.saveSentryConfig({token, orgSlug, baseUrl});
			setToken('');
			setHasToken(true);
			setStatus({ok: true, text: 'Saved'});
		} catch (error) {
			setStatus({ok: false, text: error instanceof Error ? error.message : String(error)});
		}
	}

	async function test(): Promise<void> {
		setIsTesting(true);
		try {
			const result = await window.electronAPI.validateSentryConfig();
			setStatus(result.valid
				? {ok: true, text: `Connected to ${result.organization}`}
				: {ok: false, text: result.error || 'Connection failed'});
		} finally {
			setIsTesting(false);
		}
	}

	return (
		<section className="settings-section">
			<h2>Sentry</h2>
			<p className="help-text" style={{marginBottom: '20px'}}>
				Lets Jørgen look up errors for the chat's system (matched on the <code>system_key</code> tag).
				Create a personal token at{' '}
				<a href="https://spy-aps.sentry.io/settings/account/api/auth-tokens/" target="_blank" rel="noopener noreferrer">
					Sentry → User Auth Tokens
				</a>
				{' '}with the scopes <code>event:read</code>, <code>org:read</code> and <code>project:read</code>.
			</p>

			<div className="form-group">
				<label htmlFor="sentry-token">Auth Token</label>
				<input
					id="sentry-token"
					type="password"
					value={token}
					onChange={(event) => setToken(event.target.value)}
					placeholder={hasToken ? '•••••••• (saved - leave empty to keep)' : 'sntryu_...'}
				/>
			</div>

			<div className="form-row">
				<div className="form-group">
					<label htmlFor="sentry-org">Organization</label>
					<input id="sentry-org" type="text" value={orgSlug} onChange={(event) => setOrgSlug(event.target.value)}/>
				</div>
				<div className="form-group">
					<label htmlFor="sentry-url">API URL</label>
					<input id="sentry-url" type="text" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)}/>
				</div>
			</div>

			<div className="form-group">
				<div className="form-btn-flex">
					<button onClick={save} disabled={!token && !hasToken}>Save Sentry Configuration</button>
					<button onClick={test} disabled={!hasToken || isTesting}>{isTesting ? 'Testing...' : 'Test Connection'}</button>
				</div>
				{status && <span className={`status ${status.ok ? 'success' : 'error'}`}>{status.ok ? '✓' : '⚠'} {status.text}</span>}
			</div>
		</section>
	);
}
