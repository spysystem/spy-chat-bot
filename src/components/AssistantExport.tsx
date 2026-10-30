import {createContext, JSX, ReactNode, useContext, useEffect, useMemo, useState} from 'react';
import type {AssistantExportResult, AssistantExportState} from '../types';
import {useI18n} from '../i18n';
import {Icon} from './Icon';
import {SettingsSection} from './SettingsSection';
import './AssistantExport.css';

// The export to Admin's assistant, offered in three places that share one state: a modal at the
// first start, a banner at the top of the chat list and a section in Settings. The first export is
// made at the end of Jørgen's funeral (JorgenFarewell); later ones are made directly.

interface AssistantExportContextValue {
	/** null until loaded from the main process. */
	state: AssistantExportState | null;
	exporting: boolean;
	/** The export made in this session, shown with its counts. */
	result: AssistantExportResult | null;
	error: string;
	exportNow: () => Promise<void>;
	showFile: () => void;
	farewellOpen: boolean;
	openFarewell: () => void;
	closeFarewell: () => void;
}

const AssistantExportContext = createContext<AssistantExportContextValue | undefined>(undefined);

export function AssistantExportProvider({children}: { children: ReactNode }): JSX.Element {
	const [state, setState]               = useState<AssistantExportState | null>(null);
	const [exporting, setExporting]       = useState(false);
	const [result, setResult]             = useState<AssistantExportResult | null>(null);
	const [error, setError]               = useState('');
	const [farewellOpen, setFarewellOpen] = useState(false);

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
		showFile     : () => {
			void window.electronAPI.showAssistantExport();
		},
		farewellOpen,
		openFarewell : () => setFarewellOpen(true),
		closeFarewell: () => setFarewellOpen(false),
	}), [state, exporting, result, error, farewellOpen]);

	return <AssistantExportContext.Provider value={value}>{children}</AssistantExportContext.Provider>;
}

export function useAssistantExport(): AssistantExportContextValue {
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

/** Say goodbye (the funeral, which ends with the export), or Export again once one is made. */
function ExportButton({primary}: { primary: boolean }): JSX.Element {
	const {state, exporting, exportNow, openFarewell} = useAssistantExport();
	const {t}                                         = useI18n();

	if (!state?.exportedAt) {
		return (
			<button className={`btn ${primary ? 'btn-primary' : ''}`} onClick={openFarewell} disabled={!state}>
				<Icon name="candle" size={14}/>
				{t('export.farewell')}
			</button>
		);
	}
	return (
		<button className={`btn ${primary ? 'btn-primary' : ''}`} onClick={() => void exportNow()} disabled={exporting}>
			<Icon name="download" size={14}/>
			{exporting ? t('export.exporting') : t('export.again')}
		</button>
	);
}

/** Where the file went and what it holds; the folder opens on a click. */
export function ExportOutcome(): JSX.Element | null {
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

/** Shown at every start until an export is made; it cannot be put off, the funeral has to be watched. */
export function AssistantExportModal(): JSX.Element | null {
	const {state, openFarewell} = useAssistantExport();
	const {t}                   = useI18n();
	const [open, setOpen]       = useState(false);

	useEffect(() => {
		if (state && !state.exportedAt) {
			setOpen(true);
		}
	}, [state]);

	if (!open) {
		return null;
	}

	return (
		<div className="assistant-export-overlay">
			<div className="assistant-export-modal" role="dialog" aria-modal="true" aria-labelledby="assistant-export-title">
				<div className="assistant-export-icon">
					<Icon name="candle" size={24}/>
				</div>
				<h2 id="assistant-export-title">{t('export.farewellTitle')}</h2>
				<div className="assistant-export-actions">
					<button
						className="btn btn-primary btn-large"
						autoFocus
						onClick={() => {
							setOpen(false);
							openFarewell();
						}}
					>
						<Icon name="candle" size={16}/>
						{t('export.farewell')}
					</button>
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
	const {state, openFarewell} = useAssistantExport();
	const {t}                   = useI18n();
	const exportedDate          = useExportedDate();

	return (
		<SettingsSection id="settings-assistant-export" title={t('settings.export.title')} description={t('settings.export.desc')}>
			<div className="assistant-export-settings-row">
				<ExportButton primary/>
				<span className="assistant-export-counts">
					{state?.exportedAt ? t('export.exportedOn', {date: exportedDate}) : t('settings.export.never')}
				</span>
				{state?.exportedAt && (
					<button className="btn btn-ghost" onClick={openFarewell}>
						<Icon name="candle" size={14}/>
						{t('farewell.watchAgain')}
					</button>
				)}
			</div>
			<ExportOutcome/>
		</SettingsSection>
	);
}
