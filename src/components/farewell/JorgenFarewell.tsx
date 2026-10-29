import {CSSProperties, JSX, useEffect, useMemo, useState} from 'react';
import {useI18n} from '../../i18n';
import {useAssistantExport} from '../AssistantExport';
import {Icon} from '../Icon';
import {type Life, NO_LIFE, readLife} from './life';
import {
	AscensionScene,
	BurialScene,
	eulogyLineMs,
	EulogyScene,
	FirstsScene,
	FLATLINE_AT,
	IntroScene,
	LobbyScene,
	MemoriesScene,
	MonitorScene,
	TestamentScene,
	TitleScene,
} from './Scenes';
import {FuneralSound, type Tune} from './sound';
import './JorgenFarewell.css';

// Jørgen's funeral, played before the first export to Admin's assistant: he dies on the heart
// monitor, the supporter's own questions flash by, a eulogy, the burial in the rain, his ascension,
// and a jazz-funeral party around his will, whose button makes the export.

type Scene = 'intro' | 'monitor' | 'title' | 'memories' | 'firsts' | 'eulogy' | 'burial' | 'ascension' | 'testament';

const SCENE_MS: Record<Exclude<Scene, 'eulogy' | 'testament'>, number> = {
	intro    : 6800,
	monitor  : Math.round(FLATLINE_AT * 1000) + 5200,
	title    : 9000,
	memories : 13500,
	firsts   : 12000,
	burial   : 14500,
	ascension: 8500,
};

const SCENE_TUNES: Partial<Record<Scene, Tune>> = {
	title    : 'march',
	ascension: 'choir',
	testament: 'saints',
};

export function JorgenFarewell(): JSX.Element | null {
	const {farewellOpen} = useAssistantExport();
	return farewellOpen ? <Funeral/> : null;
}

function Funeral(): JSX.Element | null {
	const {state, closeFarewell} = useAssistantExport();
	const {t}                    = useI18n();
	const [life, setLife]        = useState<Life>(NO_LIFE);
	const [index, setIndex]      = useState(0);
	const [muted, setMuted]      = useState(false);
	const [started, setStarted]  = useState(false);
	const [sound, setSound]      = useState<FuneralSound | null>(null);
	// The first time it has to be watched to the will; after an export it is a rerun that can be left.
	const [rerun]                = useState(() => Boolean(state?.exportedAt));

	useEffect(() => {
		void window.electronAPI.getChats().then((chats) => setLife(readLife(chats)));
	}, []);

	useEffect(() => {
		if (!started) {
			return;
		}
		const created = new FuneralSound();
		setSound(created);
		return () => created.close();
	}, [started]);

	useEffect(() => () => {
		if (document.fullscreenElement) {
			void document.exitFullscreen();
		}
	}, []);

	const eulogy = useMemo<string[]>(() => [
		t('farewell.eulogy.careful'),
		t('farewell.eulogy.questions', {questions: life.questions.length}),
		t('farewell.eulogy.doubleCheck'),
		t('farewell.eulogy.noHoliday'),
		life.topSystem ? t('farewell.eulogy.system', {system: life.topSystem}) : t('farewell.eulogy.clarify'),
		t('farewell.eulogy.developers'),
		t('farewell.eulogy.excel'),
		t('farewell.eulogy.followups'),
	], [t, life]);

	const scenes = useMemo<Scene[]>(
		() => ['intro', 'monitor', 'title', 'memories', ...(life.questions.length > 0 ? ['firsts' as const] : []), 'eulogy', 'burial', 'ascension', 'testament'],
		[life.questions.length],
	);
	const scene    = scenes[Math.min(index, scenes.length - 1)];
	const duration = scene === 'testament' ? 0 : scene === 'eulogy' ? eulogy.reduce((total, line) => total + eulogyLineMs(line), 600) : SCENE_MS[scene];
	const leavable = rerun || (sound !== null && scene === 'testament');

	useEffect(() => {
		if (!sound || scene === 'testament') {
			return;
		}
		const timer = window.setTimeout(() => setIndex((previous) => previous + 1), duration);
		return () => window.clearTimeout(timer);
	}, [sound, scene, duration]);

	useEffect(() => {
		const tune = SCENE_TUNES[scene];
		if (tune) {
			sound?.playTune(tune);
		}
	}, [sound, scene]);

	useEffect(() => {
		sound?.setMuted(muted);
	}, [sound, muted]);

	useEffect(() => {
		if (!leavable) {
			return;
		}
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				closeFarewell();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [leavable, closeFarewell]);

	const start = (): void => {
		// The scenes are laid out for a whole screen; in the app's window they get cropped. Electron
		// turns this request into a fullscreen window, and if it is refused the funeral plays in the window.
		document.documentElement.requestFullscreen().catch(() => undefined);
		setStarted(true);
	};

	const closeButton = leavable && (
		<button className="farewell-close" onClick={closeFarewell} title={t('farewell.close')}>
			<Icon name="x" size={18}/>
		</button>
	);

	if (!sound) {
		return (
			<div className="farewell farewell-scene-lobby" role="dialog" aria-modal="true" aria-label={t('export.farewell')}>
				<div className="farewell-stage">
					<div className="farewell-camera">
						<LobbyScene onStart={start}/>
					</div>
				</div>
				<div className="farewell-vignette"/>
				{closeButton}
			</div>
		);
	}

	const props = {life, sound};
	return (
		<div className={`farewell farewell-scene-${scene}`} role="dialog" aria-modal="true" aria-label={t('export.farewell')}>
			<div key={scene} className="farewell-stage" style={{'--scene-seconds': `${(duration || 60000) / 1000}s`} as CSSProperties}>
				<div className="farewell-camera">
					{scene === 'intro' && <IntroScene {...props}/>}
					{scene === 'monitor' && <MonitorScene {...props}/>}
					{scene === 'title' && <TitleScene {...props}/>}
					{scene === 'memories' && <MemoriesScene {...props}/>}
					{scene === 'firsts' && <FirstsScene {...props}/>}
					{scene === 'eulogy' && <EulogyScene lines={eulogy}/>}
					{scene === 'burial' && <BurialScene {...props}/>}
					{scene === 'ascension' && <AscensionScene/>}
					{scene === 'testament' && <TestamentScene {...props}/>}
				</div>
			</div>

			<div className="farewell-vignette"/>
			<div className="farewell-grain"/>
			<div className="farewell-letterbox top"/>
			<div className="farewell-letterbox bottom"/>

			<div className="farewell-controls">
				<button className="farewell-control" onClick={() => setMuted(!muted)}>
					{muted ? t('farewell.unmute') : t('farewell.mute')}
				</button>
				{rerun && scene !== 'testament' && (
					<button className="farewell-control" onClick={() => setIndex(scenes.length - 1)}>
						{t('farewell.skip')}
						<Icon name="chevronRight" size={14}/>
					</button>
				)}
			</div>
			{closeButton}
		</div>
	);
}
