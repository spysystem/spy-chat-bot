import {JSX, useEffect, useRef, useState} from 'react';
import {useI18n} from '../i18n';
import type {ReplyContactSummary, ReplyLanguage} from '../types';
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

const recipientStorageKey = (chatId: string): string => `reply_recipient_${chatId}`;

export function CustomerReplyModal({chatId, messageIndex, onClose}: CustomerReplyModalProps): JSX.Element {
	const {t}                               = useI18n();
	const [language, setLanguage]           = useState<ReplyLanguage>('auto');
	const [instructions, setInstructions]   = useState('');
	const [recipient, setRecipient]         = useState(() => localStorage.getItem(recipientStorageKey(chatId)) ?? '');
	const [contacts, setContacts]           = useState<ReplyContactSummary[]>([]);
	const [toneNote, setToneNote]           = useState('');
	const [pastedExample, setPastedExample] = useState<string | null>(null);
	const [draft, setDraft]                 = useState('');
	const [isWriting, setIsWriting]         = useState(false);
	const [error, setError]                 = useState('');
	const [copied, setCopied]               = useState(false);
	// A reply that arrives after a newer request, or after the modal closed, is dropped.
	const requestReference                  = useRef(0);

	const recipientName = recipient.trim();
	const contact       = findContact(contacts, recipientName);

	async function loadContacts(): Promise<ReplyContactSummary[]> {
		const list = await window.electronAPI.getReplyContacts(chatId);
		setContacts(list);
		return list;
	}

	// Saving before writing makes a just-typed note part of the next reply.
	async function saveToneNote(): Promise<void> {
		if (recipientName && toneNote.trim() !== (contact?.toneNote ?? '')) {
			await window.electronAPI.saveReplyTone(chatId, recipientName, toneNote);
			await loadContacts();
		}
	}

	async function writeReply(): Promise<void> {
		const request = ++requestReference.current;
		setIsWriting(true);
		setError('');
		try {
			await saveToneNote();
			const text = await window.electronAPI.draftCustomerReply(chatId, messageIndex, {language, instructions, recipientName});
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
		void loadContacts().then((list) => setToneNote(findContact(list, recipientName)?.toneNote ?? ''));
		void writeReply();
		return () => {
			requestReference.current++;
		};
	}, [chatId, messageIndex]);

	function changeRecipient(name: string): void {
		setRecipient(name);
		setToneNote(findContact(contacts, name.trim())?.toneNote ?? '');
		setPastedExample(null);
		localStorage.setItem(recipientStorageKey(chatId), name.trim());
	}

	// The copied text, with the staff member's own edits, is the best example of how they write to this person.
	async function copyDraft(): Promise<void> {
		await navigator.clipboard.writeText(draft);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
		if (recipientName) {
			await saveToneNote();
			await window.electronAPI.addReplyExample(chatId, recipientName, draft);
			await loadContacts();
		}
	}

	async function savePastedExample(): Promise<void> {
		if (pastedExample?.trim()) {
			await window.electronAPI.addReplyExample(chatId, recipientName, pastedExample);
			await loadContacts();
		}
		setPastedExample(null);
	}

	async function clearExamples(): Promise<void> {
		await window.electronAPI.clearReplyExamples(chatId, recipientName);
		await loadContacts();
	}

	const exampleCount = contact?.exampleCount ?? 0;

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
					<label className="reply-field reply-recipient">
						<span>{t('reply.recipient')}</span>
						<input
							type="text"
							list="reply-contacts"
							value={recipient}
							onChange={(event) => changeRecipient(event.target.value)}
							placeholder={t('reply.recipientHint')}
							disabled={isWriting}
						/>
						<datalist id="reply-contacts">
							{contacts.map((c) => <option key={c.name} value={c.name}/>)}
						</datalist>
					</label>
					<label className="reply-field reply-language">
						<span>{t('reply.language')}</span>
						<select value={language} onChange={(event) => setLanguage(event.target.value as ReplyLanguage)} disabled={isWriting}>
							<option value="auto">{t('reply.languageAuto')}</option>
							{LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
						</select>
					</label>
				</div>

				{recipientName && (
					<div className="reply-tone">
						<label className="reply-field">
							<span>{t('reply.tone', {name: recipientName})}</span>
							<input
								type="text"
								value={toneNote}
								onChange={(event) => setToneNote(event.target.value)}
								onBlur={() => void saveToneNote()}
								placeholder={t('reply.toneHint')}
								disabled={isWriting}
							/>
						</label>
						<div className="reply-examples">
							<span>{exampleCount > 0 ? t('reply.examples', {count: exampleCount}) : t('reply.noExamples')}</span>
							{pastedExample === null && (
								<button type="button" className="link-button" onClick={() => setPastedExample('')}>{t('reply.addExample')}</button>
							)}
							{exampleCount > 0 && pastedExample === null && (
								<button type="button" className="link-button" onClick={() => void clearExamples()}>{t('reply.clearExamples')}</button>
							)}
						</div>
						{pastedExample !== null && (
							<div className="reply-paste">
								<textarea
									value={pastedExample}
									onChange={(event) => setPastedExample(event.target.value)}
									placeholder={t('reply.addExampleHint', {name: recipientName})}
									autoFocus
								/>
								<div className="reply-paste-actions">
									<button className="btn" onClick={() => setPastedExample(null)}>{t('common.cancel')}</button>
									<button className="btn" onClick={() => void savePastedExample()} disabled={!pastedExample.trim()}>{t('common.save')}</button>
								</div>
							</div>
						)}
					</div>
				)}

				<label className="reply-field">
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

function findContact(contacts: ReplyContactSummary[], name: string): ReplyContactSummary | undefined {
	const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
	return key ? contacts.find((c) => c.name.trim().toLowerCase().replace(/\s+/g, ' ') === key) : undefined;
}
