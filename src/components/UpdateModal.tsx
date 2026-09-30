import {Fragment, JSX} from 'react';
import {Icon} from './Icon';
import {useI18n} from '../i18n';
import './UpdateModal.css';

interface UpdateModalProps {
	isOpen: boolean;
	version: string;
	isDownloading: boolean;
	downloadProgress?: number;
	isReady: boolean;
	error?: string;
	onDownload: () => void;
	onInstall: () => void;
	onDismiss?: () => void;
	forceUpdate?: boolean;
}

export function UpdateModal(
	{
		isOpen,
		version,
		isDownloading,
		downloadProgress = 0,
		isReady,
		error,
		onDownload,
		onInstall,
		onDismiss,
		forceUpdate = false,
	}: UpdateModalProps): JSX.Element | null {
	const {t} = useI18n();

	if (!isOpen) {
		return null;
	}

	return (
		<div className="update-modal-overlay">
			<div className="update-modal">
				<div className={`update-modal-icon ${isReady ? 'ready' : ''}`}>
					<Icon name={isReady ? 'check' : 'download'} size={24}/>
				</div>

				<h2 className="update-modal-title">
					{isReady ? t('update.ready') : isDownloading ? t('update.downloading') : t('update.available')}
				</h2>

				{!isReady && !isDownloading && (
					<Fragment>
						<p className="update-modal-description">
							{t('update.newVersion')} <strong>v{version}</strong>
						</p>
						{forceUpdate && (
							<div className="update-modal-warning">
								{t('update.required')}
							</div>
						)}
					</Fragment>
				)}

				{isDownloading && (
					<Fragment>
						<p className="update-modal-description">
							{t('update.downloadingVersion')} <strong>v{version}</strong>
						</p>
						<div className="update-progress-bar">
							<div
								className="update-progress-fill"
								style={{width: `${downloadProgress}%`}}
							/>
						</div>
						<p className="update-progress-text">{downloadProgress}%</p>
					</Fragment>
				)}

				{isReady && (
					<Fragment>
						<p className="update-modal-description">
							{t('update.version')} <strong>v{version}</strong> {t('update.readyText')}
						</p>
						<p className="update-modal-subdescription">
							{t('update.restartNote')}
						</p>
					</Fragment>
				)}

				{error && (
					<div className="update-modal-error">
						{error}
					</div>
				)}

				<div className="update-modal-actions">
					{!isReady && !isDownloading && (
						<Fragment>
							<button
								className="btn btn-primary"
								onClick={onDownload}
							>
								{t('update.download')}
							</button>
							{!forceUpdate && onDismiss && (
								<button
									className="btn"
									onClick={onDismiss}
								>
									{t('update.later')}
								</button>
							)}
						</Fragment>
					)}

					{isDownloading && (
						<button className="btn" disabled>
							{t('update.downloading')}
						</button>
					)}

					{isReady && (
						<Fragment>
							<button
								className="btn btn-primary"
								onClick={onInstall}
							>
								{t('update.install')}
							</button>
							{!forceUpdate && onDismiss && (
								<button
									className="btn"
									onClick={onDismiss}
								>
									{t('update.installLater')}
								</button>
							)}
						</Fragment>
					)}
				</div>
			</div>
		</div>
	);
}
