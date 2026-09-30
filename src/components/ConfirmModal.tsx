import {JSX} from 'react';
import {useI18n} from '../i18n';
import './ConfirmModal.css';

interface ConfirmModalProps {
	isOpen: boolean;
	title: string;
	message: string;
	onConfirm: () => void;
	onCancel: () => void;
	confirmText?: string;
}

export function ConfirmModal({isOpen, title, message, onConfirm, onCancel, confirmText}: ConfirmModalProps): JSX.Element | null {
	const {t} = useI18n();

	if (!isOpen) {
		return null;
	}

	return (
		<div
			className="modal-overlay"
			onClick={onCancel}
			onKeyDown={(event) => {
				if (event.key === 'Escape') {
					onCancel();
				}
			}}
		>
			<div className="modal-content" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
				<h2>{title}</h2>
				<p>{message}</p>
				<div className="modal-actions">
					<button className="btn" onClick={onCancel}>
						{t('common.cancel')}
					</button>
					<button className="btn btn-danger" onClick={onConfirm} autoFocus>
						{confirmText ?? t('app.deleteConfirm')}
					</button>
				</div>
			</div>
		</div>
	);
}
