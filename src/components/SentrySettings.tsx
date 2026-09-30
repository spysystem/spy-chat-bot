import {JSX, useEffect, useState} from 'react';
import {SettingsSection, StatusText} from './SettingsSection';
import {useI18n} from '../i18n';

export function SentrySettings(): JSX.Element {
	const {t}                       = useI18n();
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
			setStatus({ok: true, text: t('settings.sentry.saved')});
		} catch (error) {
			setStatus({ok: false, text: error instanceof Error ? error.message : String(error)});
		}
	}

	async function test(): Promise<void> {
		setIsTesting(true);
		try {
			const result = await window.electronAPI.validateSentryConfig();
			setStatus(result.valid
				? {ok: true, text: t('settings.sentry.connected', {org: result.organization ?? ''})}
				: {ok: false, text: result.error || t('settings.sentry.failed')});
		} finally {
			setIsTesting(false);
		}
	}

	return (
		<SettingsSection
			id="settings-sentry"
			title="Sentry"
			description={
				<>
					{t('settings.sentry.desc1')} <code>system_key</code>{t('settings.sentry.desc2')}{' '}
					<a href="https://spy-aps.sentry.io/settings/account/api/auth-tokens/" target="_blank" rel="noopener noreferrer">
						Sentry → User Auth Tokens
					</a>
					{' '}{t('settings.sentry.desc3')} <code>event:read</code>, <code>org:read</code> {t('settings.sentry.and')} <code>project:read</code>.
				</>
			}
		>
			<div className="form-group">
				<label htmlFor="sentry-token">{t('settings.sentry.token')}</label>
				<input
					id="sentry-token"
					type="password"
					value={token}
					onChange={(event) => setToken(event.target.value)}
					placeholder={hasToken ? t('settings.sentry.tokenKept') : 'sntryu_...'}
				/>
			</div>

			<div className="form-row">
				<div className="form-group">
					<label htmlFor="sentry-org">{t('settings.sentry.org')}</label>
					<input id="sentry-org" type="text" value={orgSlug} onChange={(event) => setOrgSlug(event.target.value)}/>
				</div>
				<div className="form-group">
					<label htmlFor="sentry-url">{t('settings.sentry.url')}</label>
					<input id="sentry-url" type="text" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)}/>
				</div>
			</div>

			<div className="form-actions">
				<button className="btn btn-primary" onClick={save} disabled={!token && !hasToken}>{t('common.save')}</button>
				<button className="btn" onClick={test} disabled={!hasToken || isTesting}>{isTesting ? t('common.testing') : t('common.testConnection')}</button>
				{status && <StatusText ok={status.ok}>{status.ok ? '✓' : '⚠'} {status.text}</StatusText>}
			</div>
		</SettingsSection>
	);
}
