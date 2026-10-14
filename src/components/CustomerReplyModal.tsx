import {JSX, useEffect, useRef, useState} from 'react';
import {useI18n} from '../i18n';
import type {ReplyLanguage} from '../types';
import {Icon} from './Icon';
import './ConfirmModal.css';
import './CustomerReplyModal.css';

interface CustomerReplyModalProps {
	chatId: string;
	messageIndex: number;
	onClose: () => void;
}

const LANGUAGE_OPTIONS: Array<{ value: Exclude<ReplyLanguage, 'auto'>; label: string }> = [
	{value: 'da', label: 'Dansk'},
	{value: 'en', label: 'English'},
	{value: 'sv', label: 'Svenska'},
	{value: 'no', label: 'Norsk'},
	{value: 'de', label: 'Deutsch'},
];

export function CustomerReplyModal({chatId, messageIndex, onClose}: CustomerReplyModalProps): JSX.Element {
	const {t}                             = useI18n();
	const [language, setLanguage]         = useState<ReplyLanguage>('auto');
	const [instructions, setInstructions] = useState('');
	const [draft, setDraft]               = useState('');
	const [isWriting, setIsWriting]       = useState(false);
	const [error, setError]               = useState('');
	const [copied, setCopied]             = useState(false);
	// A reply that arrives after a newer request, or after the modal closed, is dropped.
	const requestReference                = useRef(0);

	async function writeReply(): Promise<void> {
		const request            = ++requestReference.current;
		setIsWriting(true);
		setError('');
		try {
			const text = await window.electronAPI.draftCustomerReply(chatId, messageIndex, {language, instructions});
			if (request === requestReference.current) {
				setDraft(text);
			}
		} catch (writeError) {
			if (request === requestReference.current) {
				setError(writeError instanceof Error ? writeError.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(writeError));
			}
		} finally {
			if (request === requestReference.current) {
				setIsWriting(false);
			}
		}
	}

	useEffect(() => {
		void writeReply();
		return () => {
			requestReference.current++;
		};
	}, [chatId, messageIndex]);

	async function copyDraft(): Promise<void> {
		await navigator.clipboard.writeText(draft);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}

	return (
		<div
			className="modal-overlay"
			onClick={onClose}
			onKeyDown={(event) => {
				if (event.key === 'Escape') {
					onClose();
				}
			}}
		>
			<div className="modal-content reply-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
				<div className="reply-modal-header">
					<h2>{t('reply.title')}</h2>
					<button type="button" className="icon-btn" onClick={onClose} title={t('reply.close')}>
						<Icon name="x"/>
					</button>
				</div>

				<div className="reply-options">
					<label className="reply-field reply-language">
						<span>{t('reply.language')}</span>
						<select value={language} onChange={(event) => setLanguage(event.target.value as ReplyLanguage)} disabled={isWriting}>
							<option value="auto">{t('reply.languageAuto')}</option>
							{LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
						</select>
					</label>
					<label className="reply-field reply-instructions">
						<span>{t('reply.instructions')}</span>
						<input
							type="text"
							value={instructions}
							onChange={(event) => setInstructions(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter' && !isWriting) {
									void writeReply();
								}
							}}
							placeholder={t('reply.instructionsHint')}
							disabled={isWriting}
						/>
					</label>
				</div>

				<div className="reply-draft">
					{isWriting ? (
						<div className="reply-writing">
							<span className="thinking-pulse"/>
							{t('reply.writing')}
						</div>
					) : error ? (
						<div className="attachment-error">
							<Icon name="alert" size={14}/>
							{error}
						</div>
					) : (
						<textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck/>
					)}
				</div>

				<p className="reply-note">{t('reply.note')}</p>

				<div className="modal-actions">
					<button className="btn" onClick={() => void writeReply()} disabled={isWriting}>
						<Icon name="refresh" size={14}/>
						{draft || error ? t('reply.rewrite') : t('reply.write')}
					</button>
					<button className="btn btn-primary" onClick={() => void copyDraft()} disabled={isWriting || !draft}>
						<Icon name={copied ? 'check' : 'copy'} size={14}/>
						{copied ? t('chat.copied') : t('chat.copy')}
					</button>
				</div>
			</div>
		</div>
	);
}
