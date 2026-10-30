// Everything heard at Jørgen's funeral, synthesised with Web Audio so the app ships no sound files:
// the heart monitor, thunder and rain, Chopin's funeral march on an organ, a heavenly choir and
// finally "When the Saints Go Marching In" as at a New Orleans jazz funeral.

/** [MIDI note, length in beats]; note 0 is a rest. */
type Note = readonly [number, number];

export type Tune = 'march' | 'choir' | 'saints';

type Loop = 'rain' | 'flatline';

const MARCH: Note[] = [
	[70, 1], [70, 0.75], [70, 0.25], [70, 2],
	[73, 1], [72, 0.75], [72, 0.25], [70, 0.75], [70, 0.25], [69, 0.75], [70, 0.25],
	[70, 1], [70, 0.75], [70, 0.25], [70, 2],
	[73, 1], [72, 0.75], [72, 0.25], [70, 0.75], [70, 0.25], [69, 0.75], [70, 0.25],
];

const SAINTS: Note[] = [
	[60, 1], [64, 1], [65, 1], [67, 4], [0, 1],
	[60, 1], [64, 1], [65, 1], [67, 4], [0, 1],
	[60, 1], [64, 1], [65, 1], [67, 2], [64, 2], [60, 2], [64, 2], [62, 4], [0, 1],
	[64, 1], [64, 1], [62, 1], [60, 3], [60, 1], [64, 2], [67, 2], [67, 1], [65, 3], [0, 1],
	[64, 1], [65, 1], [67, 2], [64, 2], [60, 2], [62, 2], [60, 4], [0, 2],
];

const VOLUME = 0.3;

function frequency(midi: number): number {
	return 440 * 2 ** ((midi - 69) / 12);
}

export class FuneralSound {
	private readonly context = new AudioContext();
	private readonly master  = this.context.createGain();
	private readonly noise: AudioBuffer;
	private tune: Tune | null = null;
	private roundTimer        = 0;
	private music: { gain: GainNode; sources: AudioScheduledSourceNode[] } | null = null;
	private readonly loops    = new Map<Loop, { gain: GainNode; source: AudioScheduledSourceNode }>();

	constructor() {
		this.master.gain.value = VOLUME;
		this.master.connect(this.context.destination);
		this.noise = this.context.createBuffer(1, this.context.sampleRate * 2, this.context.sampleRate);
		const samples = this.noise.getChannelData(0);
		for (let index = 0; index < samples.length; index++) {
			samples[index] = Math.random() * 2 - 1;
		}
	}

	setMuted(muted: boolean): void {
		this.master.gain.setTargetAtTime(muted ? 0 : VOLUME, this.context.currentTime, 0.05);
	}

	close(): void {
		window.clearTimeout(this.roundTimer);
		void this.context.close();
	}

	playTune(tune: Tune): void {
		if (this.tune === tune) {
			return;
		}
		this.stopMusic();
		this.tune = tune;
		const gain = this.context.createGain();
		gain.connect(this.master);
		this.music = {gain, sources: []};
		const start = this.context.currentTime + 0.1;

		if (tune === 'choir') {
			// A B♭ major chord swelling in after the march's B♭ minor.
			for (const midi of [46, 58, 62, 65, 70, 74]) {
				for (const detune of [-8, 0, 7]) {
					this.voice({type: 'sawtooth', hertz: frequency(midi), detune, start, duration: 9, gain: 0.05, attack: 3, release: 2, lowpass: 1400, out: gain});
				}
			}
			return;
		}

		const notes       = tune === 'march' ? MARCH : SAINTS;
		const beatSeconds = tune === 'march' ? 0.95 : 0.27;
		// One round at a time, a second before the last one ends, so a long ceremony does not
		// create thousands of nodes up front.
		const scheduleRound = (roundStart: number): void => {
			let beat = 0;
			for (const [midi, beats] of notes) {
				const at = roundStart + beat * beatSeconds;
				if (midi !== 0 && tune === 'march') {
					this.organ(midi, at, beats * beatSeconds, 1, gain);
				} else if (midi !== 0) {
					this.voice({type: 'sawtooth', hertz: frequency(midi), start: at, duration: beats * beatSeconds * 0.92, gain: 0.32, attack: 0.02, release: 0.08, lowpass: 2200, out: gain});
					this.voice({type: 'square', hertz: frequency(midi + 12), start: at, duration: beats * beatSeconds * 0.9, gain: 0.06, attack: 0.02, release: 0.08, lowpass: 3000, out: gain});
				}
				for (let offset = 0; offset < beats; offset++) {
					if (Number.isInteger(beat + offset)) {
						this.accompany(tune, midi, beat + offset, roundStart + (beat + offset) * beatSeconds, beatSeconds, gain);
					}
				}
				beat += beats;
			}
			const next = roundStart + beat * beatSeconds;
			this.roundTimer = window.setTimeout(() => scheduleRound(next), (next - this.context.currentTime - 1) * 1000);
		};
		scheduleRound(start);
	}

	stopMusic(): void {
		if (!this.music) {
			return;
		}
		window.clearTimeout(this.roundTimer);
		const {gain, sources} = this.music;
		const now             = this.context.currentTime;
		gain.gain.setTargetAtTime(0, now, 0.25);
		for (const source of sources) {
			source.stop(now + 1.5);
		}
		this.music = null;
		this.tune  = null;
	}

	beep(): void {
		this.voice({type: 'sine', hertz: 988, start: this.context.currentTime, duration: 0.11, gain: 0.25, attack: 0.005, release: 0.03});
	}

	/** A low hit under a title card. */
	boom(): void {
		const now        = this.context.currentTime;
		const oscillator = this.context.createOscillator();
		const envelope   = this.context.createGain();
		oscillator.frequency.setValueAtTime(70, now);
		oscillator.frequency.exponentialRampToValueAtTime(28, now + 1.8);
		envelope.gain.setValueAtTime(0.9, now);
		envelope.gain.exponentialRampToValueAtTime(0.001, now + 2.4);
		oscillator.connect(envelope).connect(this.master);
		oscillator.start(now);
		oscillator.stop(now + 2.5);
		this.noiseBurst({start: now, duration: 1.2, gain: 0.25, filter: 'lowpass', hertz: 600});
	}

	thunder(): void {
		const now = this.context.currentTime;
		this.noiseBurst({start: now, duration: 0.25, gain: 0.5, filter: 'highpass', hertz: 1800});
		this.noiseBurst({start: now + 0.05, duration: 3.5, gain: 1.4, filter: 'lowpass', hertz: 260, playbackRate: 0.6});
	}

	pop(): void {
		const now = this.context.currentTime;
		this.noiseBurst({start: now, duration: 0.35, gain: 0.35, filter: 'bandpass', hertz: 500 + Math.random() * 900});
		this.noiseBurst({start: now + 0.15, duration: 0.9, gain: 0.08, filter: 'highpass', hertz: 4000});
	}

	shutter(): void {
		const now = this.context.currentTime;
		this.noiseBurst({start: now, duration: 0.05, gain: 0.5, filter: 'highpass', hertz: 3000});
		this.noiseBurst({start: now + 0.09, duration: 0.07, gain: 0.35, filter: 'highpass', hertz: 2000});
	}

	startLoop(loop: Loop): void {
		if (this.loops.has(loop)) {
			return;
		}
		const gain = this.context.createGain();
		gain.gain.value = 0;
		gain.connect(this.master);
		let source: AudioScheduledSourceNode;
		if (loop === 'rain') {
			const buffer  = this.context.createBufferSource();
			buffer.buffer = this.noise;
			buffer.loop   = true;
			const filter           = this.context.createBiquadFilter();
			filter.type            = 'bandpass';
			filter.frequency.value = 2500;
			filter.Q.value         = 0.4;
			buffer.connect(filter).connect(gain);
			gain.gain.setTargetAtTime(0.35, this.context.currentTime, 0.8);
			source = buffer;
		} else {
			const oscillator           = this.context.createOscillator();
			oscillator.frequency.value = 988;
			oscillator.connect(gain);
			gain.gain.setTargetAtTime(0.22, this.context.currentTime, 0.005);
			source = oscillator;
		}
		source.start();
		this.loops.set(loop, {gain, source});
	}

	stopLoop(loop: Loop): void {
		const playing = this.loops.get(loop);
		if (!playing) {
			return;
		}
		const now = this.context.currentTime;
		playing.gain.gain.setTargetAtTime(0, now, loop === 'rain' ? 0.6 : 0.3);
		playing.source.stop(now + 3);
		this.loops.delete(loop);
	}

	/** The march's left hand swings between B♭ minor and G♭ major; the band's tuba plays root and fifth. */
	private accompany(tune: Tune, melody: number, beat: number, start: number, beatSeconds: number, out: GainNode): void {
		if (tune === 'march') {
			for (const midi of beat % 2 === 0 ? [46, 53, 58] : [42, 49, 54]) {
				this.organ(midi, start, beatSeconds * 0.9, 0.35, out);
			}
			return;
		}
		const root = melody === 62 ? 43 : melody === 65 ? 41 : 48;
		this.voice({type: 'triangle', hertz: frequency(beat % 2 === 0 ? root : root + 7), start, duration: beatSeconds * 0.8, gain: 0.35, attack: 0.01, release: 0.05, out});
		if (beat % 2 === 1) {
			this.noiseBurst({start, duration: 0.08, gain: 0.12, filter: 'highpass', hertz: 7000, out});
		}
	}

	private organ(midi: number, start: number, duration: number, level: number, out: GainNode): void {
		for (const [harmonic, gain] of [[1, 0.4], [2, 0.2], [4, 0.07]] as const) {
			this.voice({type: 'sine', hertz: frequency(midi) * harmonic, start, duration, gain: gain * level, attack: 0.04, release: 0.25, out});
		}
	}

	private voice(options: {
		type: OscillatorType;
		hertz: number;
		detune?: number;
		start: number;
		duration: number;
		gain: number;
		attack: number;
		release: number;
		lowpass?: number;
		out?: AudioNode;
	}): void {
		const {type, hertz, detune = 0, start, duration, gain, attack, release, lowpass, out = this.master} = options;
		const oscillator = this.context.createOscillator();
		const envelope   = this.context.createGain();
		oscillator.type            = type;
		oscillator.frequency.value = hertz;
		oscillator.detune.value    = detune;
		envelope.gain.setValueAtTime(0, start);
		envelope.gain.linearRampToValueAtTime(gain, start + attack);
		envelope.gain.setValueAtTime(gain, start + Math.max(attack, duration - release));
		envelope.gain.linearRampToValueAtTime(0, start + duration + release);

		let output: AudioNode = oscillator;
		if (lowpass) {
			const filter           = this.context.createBiquadFilter();
			filter.type            = 'lowpass';
			filter.frequency.value = lowpass;
			output                 = oscillator.connect(filter);
		}
		output.connect(envelope).connect(out);
		oscillator.start(start);
		oscillator.stop(start + duration + release + 0.05);
		if (out !== this.master) {
			this.music?.sources.push(oscillator);
		}
	}

	private noiseBurst(options: {
		start: number;
		duration: number;
		gain: number;
		filter: BiquadFilterType;
		hertz: number;
		playbackRate?: number;
		out?: AudioNode;
	}): void {
		const {start, duration, gain, filter, hertz, playbackRate = 1, out = this.master} = options;
		const source   = this.context.createBufferSource();
		const shaping  = this.context.createBiquadFilter();
		const envelope = this.context.createGain();
		source.buffer             = this.noise;
		source.playbackRate.value = playbackRate;
		shaping.type              = filter;
		shaping.frequency.value   = hertz;
		envelope.gain.setValueAtTime(gain, start);
		envelope.gain.exponentialRampToValueAtTime(0.001, start + duration);
		source.connect(shaping).connect(envelope).connect(out);
		source.start(start);
		source.stop(start + duration + 0.05);
		if (out !== this.master) {
			this.music?.sources.push(source);
		}
	}
}
