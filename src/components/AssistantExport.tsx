import {createContext, JSX, ReactNode, useContext, useEffect, useMemo, useState} from 'react';
import type {AssistantExportResult, AssistantExportState} from '../types';
import {useI18n} from '../i18n';
import {Icon} from './Icon';
import {SettingsSection} from './SettingsSection';
import './AssistantExport.css';

// The export to Admin's assistant, offered in three places that share one state: a modal at the
// first start, a banner at the top of the chat list and a section in Settings.

interface AssistantExportContextValue {
	/** null until loaded from the main process. */
	state: AssistantExportState | null;
	exporting: boolean;
	/** The export made in this session, shown with its counts. */
	result: AssistantExportResult | null;
	error: string;
	exportNow: () => Promise<void>;
	dismissPrompt: () => Promise<void>;
	showFile: () => void;
}

const AssistantExportContext = createContext<AssistantExportContextValue | undefined>(undefined);

export function AssistantExportProvider({children}: { children: ReactNode }): JSX.Element {
	const [state, setState]         = useState<AssistantExportState | null>(null);
	const [exporting, setExporting] = useState(false);
	const [result, setResult]       = useState<AssistantExportResult | null>(null);
	const [error, setError]         = useState('');

	useEffect(() => {
		void window.electronAPI.getAssistantExportState().then(setState);
	}, []);

	const value = useMemo<AssistantExportContextValue>(() => ({
		state,
		exporting,
		result,
		error,
		exportNow    : async () => {
			setExporting(true);
			setError('');
			try {
				const response = await window.electronAPI.exportToAssistant();
				if (response.success && response.result && response.state) {
					setResult(response.result);
					setState(response.state);
				} else {
					setError(response.error ?? 'Unknown error');
				}
			} catch (exportError) {
				setError(exportError instanceof Error ? exportError.message : String(exportError));
			} finally {
				setExporting(false);
			}
		},
		dismissPrompt: async () => {
			setState(await window.electronAPI.dismissAssistantExportPrompt());
		},
		showFile     : () => {
			void window.electronAPI.showAssistantExport();
		},
	}), [state, exporting, result, error]);

	return <AssistantExportContext.Provider value={value}>{children}</AssistantExportContext.Provider>;
}

function useAssistantExport(): AssistantExportContextValue {
	const context = useContext(AssistantExportContext);
	if (!context) {
		throw new Error('useAssistantExport must be used inside AssistantExportProvider');
	}
	return context;
}

function useExportedDate(): string {
	const {state}  = useAssistantExport();
	const {locale} = useI18n();
	return state?.exportedAt ? new Date(state.exportedAt).toLocaleDateString(locale, {day: 'numeric', month: 'long', year: 'numeric'}) : '';
}

/** Export, or Export again once one is made. */
function ExportButton({primary}: { primary: boolean }): JSX.Element {
	const {state, exporting, exportNow} = useAssistantExport();
	const {t}                           = useI18n();

	return (
		<button className={`btn ${primary ? 'btn-primary' : ''}`} onClick={() => void exportNow()} disabled={exporting || !state}>
			<Icon name="download" size={14}/>
			{exporting ? t('export.exporting') : state?.exportedAt ? t('export.again') : t('export.button')}
		</button>
	);
}

/** Where the file went and what it holds; the folder opens on a click. */
function ExportOutcome(): JSX.Element | null {
	const {result, error, showFile} = useAssistantExport();
	const {t}                       = useI18n();

	if (error) {
		return <div className="assistant-export-error">{t('export.failed', {error})}</div>;
	}
	if (!result) {
		return null;
	}
	return (
		<div className="assistant-export-outcome">
			<div>
				{t('export.savedIn')} <strong>{result.filePath.split(/[\\/]/).pop()}</strong>
			</div>
			<div className="assistant-export-counts">
				{t('export.counts', {chats: result.chatCount, contacts: result.replyContactCount, attachments: result.attachmentCount})}
			</div>
			{result.missingAttachmentCount > 0 && (
				<div className="assistant-export-counts">{t('export.missing', {count: result.missingAttachmentCount})}</div>
			)}
			<button className="btn" onClick={showFile}>
				<Icon name="file" size={14}/>
				{t('export.showFile')}
			</button>
		</div>
	);
}

/** Shown once, at the first start after the update; Later lets a supporter on a call carry on. */
export function AssistantExportModal(): JSX.Element | null {
	const {state, exporting, result, error, exportNow, dismissPrompt} = useAssistantExport();
	const {t}                                                          = useI18n();
	const [open, setOpen]                                              = useState(false);

	useEffect(() => {
		if (state && !state.promptDismissed && !state.exportedAt) {
			setOpen(true);
		}
	}, [state]);

	if (!open) {
		return null;
	}

	const done = result !== null;
	return (
		<div className="assistant-export-overlay">
			<div className="assistant-export-modal" role="dialog" aria-modal="true" aria-labelledby="assistant-export-title">
				<div className={`assistant-export-icon ${done ? 'done' : ''}`}>
					<Icon name={done ? 'check' : 'download'} size={24}/>
				</div>
				<h2 id="assistant-export-title">{done ? t('export.doneTitle') : t('export.title')}</h2>
				<p>{done ? t('export.importThere') : t('export.text')}</p>
				{(done || error) && <ExportOutcome/>}
				<div className="assistant-export-actions">
					{done ? (
						<button className="btn btn-primary btn-large" onClick={() => setOpen(false)} autoFocus>{t('export.close')}</button>
					) : (
						<>
							<button className="btn btn-primary btn-large" onClick={() => void exportNow()} disabled={exporting} autoFocus>
								<Icon name="download" size={16}/>
								{exporting ? t('export.exporting') : t('export.button')}
							</button>
							<button
								className="btn"
								disabled={exporting}
								onClick={() => {
									setOpen(false);
									void dismissPrompt();
								}}
							>
								{t('export.later')}
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

/** At the top of the chat list: the export until one is made, then when it was made. */
export function AssistantExportBanner(): JSX.Element | null {
	const {state, result, showFile} = useAssistantExport();
	const {t}                       = useI18n();
	const exportedDate              = useExportedDate();

	if (!state) {
		return null;
	}

	return (
		<div className={`assistant-export-banner ${state.exportedAt ? 'exported' : ''}`}>
			{state.exportedAt ? (
				<p>{t('export.exportedOn', {date: exportedDate})}</p>
			) : (
				<>
					<strong>{t('export.title')}</strong>
					<p>{t('export.text')}</p>
				</>
			)}
			<ExportOutcome/>
			<div className="assistant-export-banner-actions">
				<ExportButton primary={!state.exportedAt}/>
				{state.exportedAt && !result && (
					<button className="btn btn-ghost" onClick={showFile} title={t('export.showFile')}>
						<Icon name="file" size={14}/>
					</button>
				)}
			</div>
		</div>
	);
}

/** The Settings section: an export can always be made again. */
export function AssistantExportSettings(): JSX.Element {
	const {state}      = useAssistantExport();
	const {t}          = useI18n();
	const exportedDate = useExportedDate();

	return (
		<SettingsSection id="settings-assistant-export" title={t('settings.export.title')} description={t('settings.export.desc')}>
			<div className="assistant-export-settings-row">
				<ExportButton primary/>
				<span className="assistant-export-counts">
					{state?.exportedAt ? t('export.exportedOn', {date: exportedDate}) : t('settings.export.never')}
				</span>
			</div>
			<ExportOutcome/>
		</SettingsSection>
	);
}
