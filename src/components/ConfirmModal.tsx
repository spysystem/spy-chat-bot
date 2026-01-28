import {JSX} from 'react';
import './ConfirmModal.css';

interface ConfirmModalProps {
	isOpen: boolean;
	title: string;
	message: string;
	onConfirm: () => void;
	onCancel: () => void;
}

export function ConfirmModal({isOpen, title, message, onConfirm, onCancel}: ConfirmModalProps): JSX.Element | null {
	if (!isOpen) {
		return null;
	}

	return (
		<div className="modal-overlay" onClick={onCancel}>
			<div className="modal-content" onClick={(event) => event.stopPropagation()}>
				<h2>{title}</h2>
				<p>{message}</p>
				<div className="modal-actions">
					<button className="modal-button cancel" onClick={onCancel}>
						Cancel
					</button>
					<button className="modal-button confirm" onClick={onConfirm}>
						Delete
					</button>
				</div>
			</div>
		</div>
	);
}
