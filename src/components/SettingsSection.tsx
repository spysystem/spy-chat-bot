import {JSX, ReactNode} from 'react';

interface SettingsSectionProps {
	id: string;
	title: string;
	description?: ReactNode;
	children: ReactNode;
}

export function SettingsSection({id, title, description, children}: SettingsSectionProps): JSX.Element {
	return (
		<section id={id} className="settings-section">
			<div className="settings-section-head">
				<h2>{title}</h2>
				{description && <p className="section-description">{description}</p>}
			</div>
			{children}
		</section>
	);
}

export function StatusText({ok, children}: { ok: boolean; children: ReactNode }): JSX.Element {
	return <span className={`status ${ok ? 'success' : 'error'}`}>{children}</span>;
}
