import {JSX, useEffect, useRef} from 'react';

// Canvas particle effects for the funeral. One effect per canvas, so the fireworks can leave
// trails without smearing anything else.

export type Effect = 'dust' | 'embers' | 'warp' | 'rain' | 'sparkles' | 'fireworks' | 'confetti';

interface ParticleSystem {
	/** Fade the previous frame by this alpha instead of clearing it, which leaves trails. */
	trail?: number;
	step: (context: CanvasRenderingContext2D, seconds: number, width: number, height: number) => void;
}

const random = (from: number, to: number): number => from + Math.random() * (to - from);

function dust(width: number, height: number): ParticleSystem {
	const motes = Array.from({length: 90}, () => ({
		x: random(0, width), y: random(0, height), size: random(0.6, 2.4), vx: random(-8, 8), vy: random(-12, -2), phase: random(0, 6),
	}));
	let time = 0;
	return {
		step: (context, seconds, w, h) => {
			time += seconds;
			context.globalCompositeOperation = 'lighter';
			for (const mote of motes) {
				mote.x = (mote.x + mote.vx * seconds + w) % w;
				mote.y = (mote.y + mote.vy * seconds + h) % h;
				context.fillStyle = `rgba(255, 214, 150, ${0.12 + 0.3 * (Math.sin(time * 1.3 + mote.phase) + 1) / 2})`;
				context.beginPath();
				context.arc(mote.x, mote.y, mote.size, 0, Math.PI * 2);
				context.fill();
			}
		},
	};
}

function embers(): ParticleSystem {
	const sparks: Array<{ x: number; y: number; vy: number; life: number; age: number; size: number; wobble: number }> = [];
	return {
		step: (context, seconds, w, h) => {
			for (let spawn = 0; spawn < 3; spawn++) {
				if (Math.random() < seconds * 18) {
					sparks.push({x: random(w * 0.2, w * 0.8), y: h + 10, vy: random(40, 110), life: random(3, 6), age: 0, size: random(0.8, 2.6), wobble: random(0, 6)});
				}
			}
			context.globalCompositeOperation = 'lighter';
			for (let index = sparks.length - 1; index >= 0; index--) {
				const spark = sparks[index];
				spark.age += seconds;
				if (spark.age > spark.life) {
					sparks.splice(index, 1);
					continue;
				}
				spark.y -= spark.vy * seconds;
				const x    = spark.x + Math.sin(spark.age * 2 + spark.wobble) * 18;
				const fade = 1 - spark.age / spark.life;
				context.fillStyle = `rgba(255, ${Math.round(120 + 100 * fade)}, 60, ${fade * 0.9})`;
				context.beginPath();
				context.arc(x, spark.y, spark.size * (0.6 + fade), 0, Math.PI * 2);
				context.fill();
			}
		},
	};
}

function warp(): ParticleSystem {
	const stars = Array.from({length: 600}, () => ({x: random(-1, 1), y: random(-1, 1), z: random(0.05, 1)}));
	let time    = 0;
	return {
		step: (context, seconds, w, h) => {
			time += seconds;
			const speed = 0.15 + Math.min(time / 4, 1) * 1.3;
			const cx    = w / 2;
			const cy    = h / 2;
			const scale = Math.max(w, h) * 0.5;
			context.globalCompositeOperation = 'lighter';
			context.lineCap                  = 'round';
			for (const star of stars) {
				const previousZ = star.z;
				star.z -= speed * seconds;
				if (star.z <= 0.02) {
					star.x = random(-1, 1);
					star.y = random(-1, 1);
					star.z = 1;
					continue;
				}
				const brightness = 1 - star.z;
				context.strokeStyle = `rgba(${Math.round(190 + 65 * brightness)}, ${Math.round(205 + 50 * brightness)}, 255, ${brightness})`;
				context.lineWidth   = 0.5 + brightness * 2.2;
				context.beginPath();
				context.moveTo(cx + (star.x / previousZ) * scale, cy + (star.y / previousZ) * scale);
				context.lineTo(cx + (star.x / star.z) * scale, cy + (star.y / star.z) * scale);
				context.stroke();
			}
		},
	};
}

function rain(width: number, height: number): ParticleSystem {
	const drops = Array.from({length: 320}, () => ({x: random(0, width * 1.2), y: random(-height, height), length: random(10, 26), speed: random(750, 1150)}));
	return {
		step: (context, seconds, w, h) => {
			context.strokeStyle = 'rgba(170, 190, 225, 0.32)';
			context.lineWidth   = 1;
			context.beginPath();
			for (const drop of drops) {
				drop.y += drop.speed * seconds;
				drop.x -= drop.speed * 0.15 * seconds;
				if (drop.y > h) {
					drop.y = random(-80, -10);
					drop.x = random(0, w * 1.2);
				}
				context.moveTo(drop.x, drop.y);
				context.lineTo(drop.x + drop.length * 0.15, drop.y - drop.length);
			}
			context.stroke();
		},
	};
}

function sparkles(): ParticleSystem {
	const stars: Array<{ x: number; y: number; vy: number; vx: number; life: number; age: number; size: number }> = [];
	return {
		step: (context, seconds, w, h) => {
			for (let spawn = 0; spawn < 4; spawn++) {
				if (Math.random() < seconds * 30) {
					stars.push({x: random(w * 0.38, w * 0.62), y: random(h * 0.55, h * 0.95), vx: random(-30, 30), vy: random(50, 160), life: random(1.5, 3.2), age: 0, size: random(2, 6)});
				}
			}
			context.globalCompositeOperation = 'lighter';
			for (let index = stars.length - 1; index >= 0; index--) {
				const star = stars[index];
				star.age += seconds;
				if (star.age > star.life) {
					stars.splice(index, 1);
					continue;
				}
				star.x += star.vx * seconds;
				star.y -= star.vy * seconds;
				const twinkle = Math.abs(Math.sin(star.age * 9)) * (1 - star.age / star.life);
				const size    = star.size * (0.4 + twinkle);
				context.fillStyle = `rgba(255, 236, 170, ${twinkle})`;
				context.beginPath();
				context.moveTo(star.x, star.y - size * 2);
				context.lineTo(star.x + size * 0.35, star.y - size * 0.35);
				context.lineTo(star.x + size * 2, star.y);
				context.lineTo(star.x + size * 0.35, star.y + size * 0.35);
				context.lineTo(star.x, star.y + size * 2);
				context.lineTo(star.x - size * 0.35, star.y + size * 0.35);
				context.lineTo(star.x - size * 2, star.y);
				context.lineTo(star.x - size * 0.35, star.y - size * 0.35);
				context.closePath();
				context.fill();
			}
		},
	};
}

function fireworks(onBurst: () => void): ParticleSystem {
	const rockets: Array<{ x: number; y: number; vy: number; top: number; hue: number }>                        = [];
	const sparks: Array<{ x: number; y: number; vx: number; vy: number; life: number; age: number; hue: number }> = [];
	let untilNext                                                                                                 = 0.4;
	return {
		trail: 0.22,
		step : (context, seconds, w, h) => {
			untilNext -= seconds;
			if (untilNext <= 0) {
				untilNext = random(0.35, 1.0);
				rockets.push({x: random(w * 0.12, w * 0.88), y: h, vy: random(h * 0.9, h * 1.25), top: random(h * 0.12, h * 0.45), hue: random(0, 360)});
			}
			context.globalCompositeOperation = 'lighter';
			for (let index = rockets.length - 1; index >= 0; index--) {
				const rocket = rockets[index];
				rocket.y -= rocket.vy * seconds;
				context.fillStyle = `hsla(${rocket.hue}, 100%, 80%, 0.9)`;
				context.fillRect(rocket.x - 1, rocket.y, 2, 8);
				if (rocket.y <= rocket.top) {
					rockets.splice(index, 1);
					onBurst();
					const count = Math.round(random(70, 110));
					for (let spark = 0; spark < count; spark++) {
						const angle = (spark / count) * Math.PI * 2;
						const speed = random(60, 280);
						sparks.push({x: rocket.x, y: rocket.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: random(1.1, 2.1), age: 0, hue: rocket.hue + random(-20, 20)});
					}
				}
			}
			for (let index = sparks.length - 1; index >= 0; index--) {
				const spark = sparks[index];
				spark.age += seconds;
				if (spark.age > spark.life) {
					sparks.splice(index, 1);
					continue;
				}
				spark.vx *= 1 - 1.4 * seconds;
				spark.vy  = spark.vy * (1 - 1.4 * seconds) + 140 * seconds;
				spark.x  += spark.vx * seconds;
				spark.y  += spark.vy * seconds;
				context.fillStyle = `hsla(${spark.hue}, 100%, ${60 + 25 * (1 - spark.age / spark.life)}%, ${1 - spark.age / spark.life})`;
				context.beginPath();
				context.arc(spark.x, spark.y, 1.8, 0, Math.PI * 2);
				context.fill();
			}
		},
	};
}

function confetti(width: number, height: number): ParticleSystem {
	const pieces = Array.from({length: 160}, (_, index) => ({
		x   : random(0, width), y: random(-height, 0), vx: random(-30, 30), vy: random(70, 160), angle: random(0, 6), spin: random(-4, 4),
		flip: random(0, 6), flipSpeed: random(4, 9), w: random(6, 10), h: random(10, 16), hue: (index * 47) % 360,
	}));
	return {
		step: (context, seconds, w, h) => {
			for (const piece of pieces) {
				piece.x     += (piece.vx + Math.sin(piece.flip) * 25) * seconds;
				piece.y     += piece.vy * seconds;
				piece.angle += piece.spin * seconds;
				piece.flip  += piece.flipSpeed * seconds;
				if (piece.y > h + 20) {
					piece.y = random(-60, -20);
					piece.x = random(0, w);
				}
				context.save();
				context.translate(piece.x, piece.y);
				context.rotate(piece.angle);
				context.scale(1, Math.cos(piece.flip));
				context.fillStyle = `hsl(${piece.hue}, 85%, 62%)`;
				context.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
				context.restore();
			}
		},
	};
}

function createSystem(effect: Effect, width: number, height: number, onBurst: () => void): ParticleSystem {
	switch (effect) {
		case 'dust':
			return dust(width, height);
		case 'embers':
			return embers();
		case 'warp':
			return warp();
		case 'rain':
			return rain(width, height);
		case 'sparkles':
			return sparkles();
		case 'fireworks':
			return fireworks(onBurst);
		case 'confetti':
			return confetti(width, height);
	}
}

export function Particles({effect, onBurst}: { effect: Effect; onBurst?: () => void }): JSX.Element | null {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const burstRef  = useRef(onBurst);
	const reduced   = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	useEffect(() => {
		burstRef.current = onBurst;
	});

	useEffect(() => {
		const canvas  = canvasRef.current;
		const context = canvas?.getContext('2d');
		if (!canvas || !context) {
			return;
		}
		let width    = 0;
		let height   = 0;
		const resize = (): void => {
			const ratio = window.devicePixelRatio || 1;
			width         = canvas.clientWidth;
			height        = canvas.clientHeight;
			canvas.width  = width * ratio;
			canvas.height = height * ratio;
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
		};
		resize();
		const observer = new ResizeObserver(resize);
		observer.observe(canvas);

		const system = createSystem(effect, width, height, () => burstRef.current?.());
		let last     = performance.now();
		let frame    = 0;
		const tick   = (now: number): void => {
			const seconds = Math.min((now - last) / 1000, 0.05);
			last          = now;
			context.globalCompositeOperation = 'source-over';
			if (system.trail) {
				context.globalCompositeOperation = 'destination-out';
				context.fillStyle                = `rgba(0, 0, 0, ${system.trail})`;
				context.fillRect(0, 0, width, height);
				context.globalCompositeOperation = 'source-over';
			} else {
				context.clearRect(0, 0, width, height);
			}
			system.step(context, seconds, width, height);
			frame = requestAnimationFrame(tick);
		};
		frame        = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	}, [effect]);

	return reduced ? null : <canvas ref={canvasRef} className="farewell-particles" aria-hidden="true"/>;
}
