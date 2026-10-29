import {CSSProperties, JSX, useEffect, useMemo, useRef, useState} from 'react';
import {type TranslationKey, useI18n} from '../../i18n';
import {ExportOutcome, useAssistantExport} from '../AssistantExport';
import {Icon} from '../Icon';
import {type Life, nightOwl, type Question, shorten} from './life';
import {Particles} from './Particles';
import type {FuneralSound} from './sound';

export interface SceneProps {
	life: Life;
	sound: FuneralSound;
}

/** Seconds between the heart monitor's last beats; the gaps grow until the line goes flat. */
const BEAT_GAPS          = [0.75, 0.78, 0.82, 0.9, 1.0, 1.2, 1.5];
const FIRST_BEAT         = 0.5;
const BEAT_TIMES         = BEAT_GAPS.reduce((times, gap) => [...times, times[times.length - 1] + gap], [FIRST_BEAT]);
export const FLATLINE_AT = BEAT_TIMES[BEAT_TIMES.length - 1] + 1.2;

/** Time to read a eulogy line: a pause plus about 16 characters a second, so long lines stay longer. */
export function eulogyLineMs(line: string): number {
	return Math.max(5000, 1800 + line.length * 60);
}

const LAST_QUESTIONS: Array<[TranslationKey, TranslationKey]> = [
	['farewell.q1', 'farewell.a1'],
	['farewell.q2', 'farewell.a2'],
	['farewell.q3', 'farewell.a3'],
];

const random = (from: number, to: number): number => from + Math.random() * (to - from);

/** Runs each callback once, the given milliseconds after the scene starts. */
function useTimeline(steps: Array<[number, () => void]>): void {
	const stepsRef = useRef(steps);
	useEffect(() => {
		const timers = stepsRef.current.map(([ms, run]) => window.setTimeout(run, ms));
		return () => timers.forEach((timer) => window.clearTimeout(timer));
	}, []);
}

function useTypewriter(text: string, msPerCharacter: number, delayMs = 0): string {
	const [length, setLength] = useState(0);

	useEffect(() => {
		setLength(0);
		let timer   = 0;
		const start = window.setTimeout(() => {
			timer = window.setInterval(() => {
				setLength((previous) => {
					if (previous >= text.length) {
						window.clearInterval(timer);
					}
					return Math.min(previous + 1, text.length);
				});
			}, msPerCharacter);
		}, delayMs);
		return () => {
			window.clearTimeout(start);
			window.clearInterval(timer);
		};
	}, [text, msPerCharacter, delayMs]);

	return text.slice(0, length);
}

function CountUp({to, delayMs}: { to: number; delayMs: number }): JSX.Element {
	const [value, setValue] = useState(0);

	useEffect(() => {
		let frame   = 0;
		const begin = performance.now() + delayMs;
		const tick  = (now: number): void => {
			const progress = Math.min(Math.max((now - begin) / 2200, 0), 1);
			setValue(Math.round(to * (1 - (1 - progress) ** 3)));
			if (progress < 1) {
				frame = requestAnimationFrame(tick);
			}
		};
		frame       = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [to, delayMs]);

	return <>{value}</>;
}

function Lifespan({life}: { life: Life }): JSX.Element {
	const {locale} = useI18n();
	const format   = (date: Date): string => date.toLocaleDateString(locale, {day: 'numeric', month: 'long', year: 'numeric'});
	return <div className="farewell-lifespan">{life.born ? `${format(life.born)} – ${format(new Date())}` : `† ${format(new Date())}`}</div>;
}

function Candle(): JSX.Element {
	return (
		<div className="farewell-candle" aria-hidden="true">
			<div className="farewell-glow"/>
			<div className="farewell-flame"/>
			<div className="farewell-wick"/>
			<div className="farewell-wax"/>
		</div>
	);
}

function Face({className = ''}: { className?: string }): JSX.Element {
	return <span className={`farewell-face ${className}`}>J</span>;
}

/** Before the funeral: the start click is what lets it go fullscreen and play sound. */
export function LobbyScene({onStart}: { onStart: () => void }): JSX.Element {
	const {t} = useI18n();
	return (
		<div className="farewell-center farewell-lobby">
			<Candle/>
			<h2 className="farewell-heading">{t('farewell.readyTitle')}</h2>
			<p className="farewell-whisper">{t('farewell.readyText')}</p>
			<button className="btn btn-primary btn-large" onClick={onStart} autoFocus>
				<Icon name="candle" size={16}/>
				{t('farewell.readyStart')}
			</button>
			<p className="farewell-lobby-note">{t('farewell.readyNote')}</p>
		</div>
	);
}

export function IntroScene({sound}: SceneProps): JSX.Element {
	const {t} = useI18n();
	useTimeline([[400, () => sound.boom()], [3600, () => sound.boom()]]);

	return (
		<>
			<Particles effect="dust"/>
			<div className="farewell-credits">
				<p className="farewell-credit" style={{animationDelay: '0.4s'}}>{t('farewell.presents')}</p>
				<p className="farewell-credit farewell-credit-film" style={{animationDelay: '3.6s'}}>{t('farewell.aFilm')}</p>
			</div>
		</>
	);
}

/** A sweeping ECG trace: the beats come further apart until the line goes flat. */
function EcgTrace({onBeat}: { onBeat: (rate: number) => void }): JSX.Element {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const beatRef   = useRef(onBeat);

	useEffect(() => {
		beatRef.current = onBeat;
	});

	useEffect(() => {
		const canvas  = canvasRef.current;
		const context = canvas?.getContext('2d');
		if (!canvas || !context) {
			return;
		}
		const ratio   = window.devicePixelRatio || 1;
		const width   = canvas.clientWidth;
		const height  = canvas.clientHeight;
		canvas.width  = width * ratio;
		canvas.height = height * ratio;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);

		const bump   = (phase: number, at: number, spread: number): number => Math.exp(-((phase - at) ** 2) / (2 * spread ** 2));
		const signal = (time: number): number => {
			const beat = [...BEAT_TIMES].reverse().find((at) => at <= time);
			if (beat === undefined) {
				return 0;
			}
			const phase = time - beat;
			return 0.12 * bump(phase, 0.06, 0.025) - 0.12 * bump(phase, 0.17, 0.01) + bump(phase, 0.2, 0.012) - 0.28 * bump(phase, 0.23, 0.012) + 0.25 * bump(phase, 0.42, 0.05);
		};

		const speed   = width / 3.2;
		const started = performance.now();
		let previous  = {x: 0, y: height * 0.62};
		let beats     = 0;
		let frame     = 0;
		const tick    = (now: number): void => {
			const time = (now - started) / 1000;
			while (beats < BEAT_TIMES.length && BEAT_TIMES[beats] + 0.2 <= time) {
				beatRef.current(beats < BEAT_GAPS.length ? Math.round(60 / BEAT_GAPS[beats]) : 0);
				beats++;
			}
			const flat = time >= FLATLINE_AT;
			const x    = (time * speed) % width;
			const y    = height * 0.62 - signal(time) * height * 0.5;
			context.clearRect(x, 0, 28, height);
			context.strokeStyle = flat ? '#ff4d5e' : '#3dff9a';
			context.shadowColor = context.strokeStyle;
			context.shadowBlur  = 10;
			context.lineWidth   = 2.4;
			context.lineJoin    = 'round';
			context.beginPath();
			context.moveTo(x < previous.x ? 0 : previous.x, x < previous.x ? y : previous.y);
			context.lineTo(x, y);
			context.stroke();
			previous = {x, y};
			frame    = requestAnimationFrame(tick);
		};
		frame         = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, []);

	return <canvas ref={canvasRef} className="farewell-ecg"/>;
}

export function MonitorScene({sound}: SceneProps): JSX.Element {
	const {t, locale}       = useI18n();
	const [rate, setRate]   = useState(80);
	const [pulse, setPulse] = useState(0);
	const [dead, setDead]   = useState(false);
	const [stamp, setStamp] = useState(false);
	const lastWords         = useTypewriter(t('farewell.lastWords'), 70, 1200);
	const timeOfDeath       = useMemo(() => new Date(Date.now() + FLATLINE_AT * 1000).toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'}), [locale]);

	useTimeline([
		[FLATLINE_AT * 1000, () => {
			setDead(true);
			setRate(0);
			sound.startLoop('flatline');
		}],
		[FLATLINE_AT * 1000 + 1300, () => {
			setStamp(true);
			sound.boom();
		}],
		[FLATLINE_AT * 1000 + 3600, () => sound.stopLoop('flatline')],
	]);
	useEffect(() => () => sound.stopLoop('flatline'), [sound]);

	return (
		<div className={`farewell-ward ${dead ? 'dead' : ''} ${stamp ? 'stamped' : ''}`}>
			<div className="farewell-alarm-light"/>
			<div className="farewell-monitor">
				<div className="farewell-monitor-screen">
					<EcgTrace onBeat={(next) => {
						setRate(next);
						setPulse((previous) => previous + 1);
						sound.beep();
					}}/>
					<div className="farewell-monitor-side">
						<div className="farewell-monitor-label">{t('farewell.monitorRate')}</div>
						<div key={pulse} className="farewell-monitor-rate">{rate}</div>
						<div className="farewell-monitor-label">{t('farewell.monitorVitals')}</div>
					</div>
					{dead && <div className="farewell-monitor-alarm">{t('farewell.monitorAlarm')}</div>}
				</div>
				<div className="farewell-monitor-brand">{t('farewell.monitorBrand')}</div>
			</div>

			<div className="farewell-bedside">
				<Face className="small"/>
				<div className="farewell-last-words">{lastWords}<span className="farewell-caret"/></div>
			</div>

			{stamp && (
				<div className="farewell-stamp">
					<span>{t('farewell.timeOfDeath')}</span>
					<strong>{timeOfDeath}</strong>
				</div>
			)}
		</div>
	);
}

export function TitleScene({life, sound}: SceneProps): JSX.Element {
	const {t} = useI18n();
	useTimeline([[200, () => sound.boom()]]);

	return (
		<>
			<Particles effect="embers"/>
			<div className="farewell-center farewell-title-scene">
				<div className="farewell-portrait">
					<Candle/>
					<div className="farewell-frame">
						<Face/>
						<div className="farewell-ribbon"/>
					</div>
					<Candle/>
				</div>
				<h1 className="farewell-title" aria-label="Spørge Jørgen">
					{[...'SPØRGE JØRGEN'].map((letter, position) => (
						<span key={position} style={{animationDelay: `${0.8 + position * 0.08}s`}}>{letter === ' ' ? ' ' : letter}</span>
					))}
				</h1>
				<Lifespan life={life}/>
				<p className="farewell-tagline">{t('farewell.tagline')}</p>
			</div>
		</>
	);
}

export function MemoriesScene({life}: SceneProps): JSX.Element {
	const {t} = useI18n();

	const cards = useMemo(() => {
		const shuffled = [...life.questions].sort(() => Math.random() - 0.5);
		const flights  = shuffled.length === 0 ? [] : Array.from({length: 18}, (_, position) => shuffled[position % shuffled.length]);
		return flights.map((question, position) => {
			const angle = random(0, Math.PI * 2);
			return {
				text : shorten(question.text, 100),
				style: {
					'--x'         : `${Math.cos(angle) * random(220, 520)}px`,
					'--y'         : `${Math.sin(angle) * random(140, 320)}px`,
					'--tilt'      : `${random(-10, 10)}deg`,
					animationDelay: `${0.8 + position * 0.55}s`,
				} as CSSProperties,
			};
		});
	}, [life.questions]);

	return (
		<>
			<Particles effect="warp"/>
			<div className="farewell-tunnel">
				{cards.map((card, position) => <div key={position} className="farewell-tunnel-card" style={card.style}>{card.text}</div>)}
			</div>
			<div className="farewell-memories">
				<h2 className="farewell-heading">{t('farewell.lifeFlashes')}</h2>
				{cards.length === 0 && <p className="farewell-whisper" style={{animationDelay: '1.5s'}}>{t('farewell.noQuestions')}</p>}
				<div className="farewell-stats">
					{([
						[life.questions.length, 'farewell.statQuestions'],
						[life.chatCount, 'farewell.statChats'],
						[life.systemCount, 'farewell.statSystems'],
					] as const).map(([count, label], position) => (
						<div key={label} className="farewell-stat" style={{animationDelay: `${1 + position * 0.3}s`}}>
							<strong><CountUp to={count} delayMs={1000 + position * 300}/></strong>
							<span>{t(label)}</span>
						</div>
					))}
				</div>
			</div>
		</>
	);
}

export function FirstsScene({life, sound}: SceneProps): JSX.Element {
	const {t, locale}       = useI18n();
	const [flash, setFlash] = useState(0);
	const first             = life.questions[0];
	const last              = life.questions[life.questions.length - 1];
	const owl               = nightOwl(life.questions);
	const longest           = life.questions.reduce((best, question) => (question.text.length > best.text.length ? question : best), first);
	const date              = (question: Question): string => question.askedAt.toLocaleDateString(locale, {day: 'numeric', month: 'long', year: 'numeric'});

	const cards = [
		{title: t('farewell.firstTitle', {date: date(first)}), text: first.text},
		owl
			? {title: t('farewell.nightTitle', {time: owl.askedAt.toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'})}), text: owl.text}
			: {title: t('farewell.longestTitle', {length: longest.text.length}), text: longest.text},
		...(last !== first ? [{title: t('farewell.lastTitle', {date: date(last)}), text: last.text}] : []),
	];
	const landings = cards.map((_, position) => 600 + position * 3200 + 900);

	useTimeline(landings.map((ms) => [ms - 150, () => {
		sound.shutter();
		setFlash((previous) => previous + 1);
	}]));

	const throws = useMemo(() => cards.map((_, position) => ({
		'--from-x'    : `${random(-60, 60)}vw`,
		'--from-spin' : `${random(-70, 70)}deg`,
		'--rest'      : `${[-5, 3, -2][position] ?? 0}deg`,
		animationDelay: `${0.6 + position * 3.2}s`,
	} as CSSProperties)), [cards.length]);

	return (
		<>
			{flash > 0 && <div key={flash} className="farewell-flash"/>}
			<div className="farewell-polaroids">
				{cards.map((card, position) => (
					<figure key={position} className="farewell-polaroid" style={throws[position]}>
						<div className="farewell-polaroid-photo">
							<div className="farewell-polaroid-bubble">{shorten(card.text, 180)}</div>
						</div>
						<figcaption>{card.title}</figcaption>
					</figure>
				))}
			</div>
		</>
	);
}

export function EulogyScene({lines}: { lines: string[] }): JSX.Element {
	const {t}               = useI18n();
	const [index, setIndex] = useState(0);

	useEffect(() => {
		if (index >= lines.length - 1) {
			return;
		}
		const timer = window.setTimeout(() => setIndex(index + 1), eulogyLineMs(lines[index]));
		return () => window.clearTimeout(timer);
	}, [index, lines]);

	return (
		<>
			<div className="farewell-rays"/>
			<Particles effect="dust"/>
			<div className="farewell-eulogy">
				<h2 className="farewell-heading">{t('farewell.eulogyTitle')}</h2>
				<p key={index} className="farewell-eulogy-line" style={{animationDuration: `${eulogyLineMs(lines[index])}ms`}}>{lines[index]}</p>
				<div className="farewell-eulogy-progress">
					{lines.map((_, position) => <i key={position} className={position <= index ? 'done' : ''}/>)}
				</div>
			</div>
		</>
	);
}

function boltPoints(): string {
	let x        = random(20, 80);
	const points = [`${x},0`];
	for (let y = 6; y <= 70; y += random(4, 9)) {
		x += random(-6, 6);
		points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
	}
	return points.join(' ');
}

export function BurialScene({life, sound}: SceneProps): JSX.Element {
	const {t}             = useI18n();
	const [bolt, setBolt] = useState<{ key: number; points: string } | null>(null);

	const strike = (): void => {
		setBolt((previous) => ({key: (previous?.key ?? 0) + 1, points: boltPoints()}));
		window.setTimeout(() => sound.thunder(), 180);
	};
	useTimeline([[900, strike], [5200, strike], [8400, strike], [12000, strike]]);

	useEffect(() => {
		sound.startLoop('rain');
		return () => sound.stopLoop('rain');
	}, [sound]);

	const flowers = useMemo(() => Array.from({length: 16}, (_, position) => ({
		left          : `${random(6, 90)}%`,
		animationDelay: `${0.3 + position * 0.2}s`,
		'--hue'       : `${[350, 330, 45, 0, 300][position % 5]}`,
		'--spin'      : `${random(180, 540)}deg`,
	} as CSSProperties)), []);

	const puffs = useMemo(() => Array.from({length: 18}, () => ({
		'--dx'  : `${random(-180, 180)}px`,
		'--dy'  : `${random(-70, -10)}px`,
		'--size': `${random(14, 40)}px`,
	} as CSSProperties)), []);

	return (
		<>
			<Particles effect="rain"/>
			{bolt && (
				<div key={bolt.key} className="farewell-lightning">
					<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
						<polyline points={bolt.points}/>
					</svg>
				</div>
			)}
			<div className="farewell-burial">
				<div className="farewell-pit">
					<div className="farewell-coffin">
						<div className="farewell-coffin-lid"/>
						<div className="farewell-coffin-plate">J</div>
						<div className="farewell-coffin-handle left"/>
						<div className="farewell-coffin-handle right"/>
						{flowers.map((style, position) => <div key={position} className="farewell-flower" style={style}/>)}
					</div>
					<div className="farewell-stone">
						<div className="farewell-stone-rests">{t('farewell.restsHere')}</div>
						<div className="farewell-stone-name">Spørge Jørgen</div>
						<Lifespan life={life}/>
						<div className="farewell-stone-epitaph">{t('farewell.epitaph')}</div>
						<small>{t('farewell.stoneFooter')}</small>
					</div>
				</div>
				<div className="farewell-ground"/>
				<div className="farewell-puffs">
					{puffs.map((style, position) => <i key={position} style={style}/>)}
				</div>
			</div>
			<div className="farewell-mourners" aria-hidden="true">
				{[[0.9, 1.1, 0.75], [1, 0.85, 1.15, 0.95]].map((group, side) => (
					<div key={side} className="farewell-mourner-group">
						{group.map((scale, position) => (
							<div key={position} className="farewell-mourner" style={{'--scale': scale, animationDelay: `${(side * 3 + position) * -0.7}s`} as CSSProperties}>
								{(side + position) % 2 === 0 && <div className="farewell-umbrella"/>}
								<div className="farewell-mourner-head"/>
								<div className="farewell-mourner-body"/>
							</div>
						))}
					</div>
				))}
			</div>
		</>
	);
}

export function AscensionScene(): JSX.Element {
	const {t} = useI18n();
	return (
		<>
			<div className="farewell-beam"/>
			<Particles effect="sparkles"/>
			<div className="farewell-ascension">
				<div className="farewell-ghost rising">
					<div className="farewell-halo"/>
					<Face/>
				</div>
				<p className="farewell-whisper" style={{animationDelay: '3s'}}>{t('farewell.butWait')}</p>
				<p className="farewell-whisper big" style={{animationDelay: '5s'}}>{t('farewell.notSad')}</p>
			</div>
		</>
	);
}

export function TestamentScene({life, sound}: SceneProps): JSX.Element {
	const {exporting, result, exportNow, closeFarewell} = useAssistantExport();
	const {t}                                           = useI18n();
	const [said, setSaid]                               = useState(t('farewell.ghostSays'));
	const typed                                         = useTypewriter(said, 30, 1400);
	const lastPop                                       = useRef(0);

	return (
		<>
			<div className="farewell-disco"/>
			<Particles
				effect="fireworks"
				onBurst={() => {
					if (performance.now() - lastPop.current > 250) {
						lastPop.current = performance.now();
						sound.pop();
					}
				}}
			/>
			<Particles effect="confetti"/>

			<div className="farewell-testament">
				<div className="farewell-ghost party">
					<div className="farewell-halo"/>
					<Face/>
					<div className="farewell-shades" aria-hidden="true"><i/><i/></div>
				</div>
				<div className="farewell-speech">{typed}<span className="farewell-caret"/></div>

				{!result && (
					<div className="farewell-last-questions">
						<span>{t('farewell.lastQuestion')}</span>
						{LAST_QUESTIONS.map(([question, answer]) => (
							<button key={question} className="farewell-chip" onClick={() => setSaid(t(answer))}>{t(question)}</button>
						))}
					</div>
				)}

				<div className="farewell-will">
					{result ? (
						<>
							<h2>{t('farewell.rip')}</h2>
							<p>{t('export.importThere')}</p>
							<ExportOutcome/>
							<button className="btn btn-primary btn-large" onClick={closeFarewell} autoFocus>{t('farewell.goodbye')}</button>
						</>
					) : (
						<>
							<div className="farewell-seal">J</div>
							<h2>{t('farewell.willTitle')}</h2>
							<p>{t('farewell.willIntro')}</p>
							<ul>
								<li>{t('farewell.willChats', {chats: life.chatCount})}</li>
								<li>{t('farewell.willContacts')}</li>
								<li>{t('farewell.willAttachments')}</li>
							</ul>
							<p className="farewell-will-not">{t('farewell.willNot')}</p>
							<div className="farewell-signature">Spørge Jørgen</div>
							<ExportOutcome/>
							<button className="btn btn-primary btn-large farewell-inherit" onClick={() => void exportNow()} disabled={exporting}>
								<Icon name="download" size={16}/>
								{exporting ? t('export.exporting') : t('farewell.inherit')}
							</button>
						</>
					)}
				</div>
			</div>
		</>
	);
}
