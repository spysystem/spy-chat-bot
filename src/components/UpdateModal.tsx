import {Fragment, JSX} from 'react';
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
	if (!isOpen) {
		return null;
	}

	return (
		<div className="update-modal-overlay">
			<div className="update-modal">
				<div className="update-modal-icon">
					{isReady ? '✅' : isDownloading ? '⏬' : '✨'}
				</div>

				<h2 className="update-modal-title">
					{isReady ? 'Update Ready!' : isDownloading ? 'Downloading Update...' : 'Update Available'}
				</h2>

				{!isReady && !isDownloading && (
					<Fragment>
						<p className="update-modal-description">
							A new version of Spørge Jørgen is available: <strong>v{version}</strong>
						</p>
						{forceUpdate && (
							<div className="update-modal-warning">
								⚠️ This update is required to continue using the application
							</div>
						)}
					</Fragment>
				)}

				{isDownloading && (
					<Fragment>
						<p className="update-modal-description">
							Downloading version <strong>v{version}</strong>
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
							Version <strong>v{version}</strong> has been downloaded and is ready to install.
						</p>
						<p className="update-modal-subdescription">
							The application will restart to complete the installation.
						</p>
					</Fragment>
				)}

				{error && (
					<div className="update-modal-error">
						⚠️ Error: {error}
					</div>
				)}

				<div className="update-modal-actions">
					{!isReady && !isDownloading && (
						<Fragment>
							<button
								className="update-modal-btn update-modal-btn-primary"
								onClick={onDownload}
							>
								Download Update
							</button>
							{!forceUpdate && onDismiss && (
								<button
									className="update-modal-btn update-modal-btn-secondary"
									onClick={onDismiss}
								>
									Remind Me Later
								</button>
							)}
						</Fragment>
					)}

					{isDownloading && (
						<button className="update-modal-btn update-modal-btn-secondary" disabled>
							Downloading...
						</button>
					)}

					{isReady && (
						<Fragment>
							<button
								className="update-modal-btn update-modal-btn-primary"
								onClick={onInstall}
							>
								🚀 Restart and Install
							</button>
							{!forceUpdate && onDismiss && (
								<button
									className="update-modal-btn update-modal-btn-secondary"
									onClick={onDismiss}
								>
									Install Later
								</button>
							)}
						</Fragment>
					)}
				</div>
			</div>
		</div>
	);
}
