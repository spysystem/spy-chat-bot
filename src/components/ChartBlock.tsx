import {JSX, useEffect, useMemo, useRef, useState} from 'react';
import {useI18n} from '../i18n';
import './ChartBlock.css';

interface ChartSeries {
	name: string;
	values: Array<number | null>;
}

interface ChartSpec {
	type: 'bar' | 'line';
	title?: string;
	x: string[];
	series: ChartSeries[];
	unit?: string;
	horizontal?: boolean;
}

// Validated categorical order (see dataviz palette): colors live in ChartBlock.css per theme.
const MAX_SERIES     = 4;
const MAX_CATEGORIES = 400;
const PLOT_HEIGHT    = 240;
const BAR_THICKNESS  = 24;
const BAR_GAP        = 2;

function parseChartSpec(raw: string): ChartSpec | null {
	let data: any;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!data || (data.type !== 'bar' && data.type !== 'line') || !Array.isArray(data.x) || !Array.isArray(data.series)) {
		return null;
	}
	const x                     = data.x.slice(0, MAX_CATEGORIES).map((v: unknown) => String(v));
	const series: ChartSeries[] = data.series
		.filter((s: any) => s && Array.isArray(s.values))
		.slice(0, MAX_SERIES)
		.map((s: any, index: number) => ({
			name  : typeof s.name === 'string' && s.name.trim() !== '' ? s.name : `Series ${index + 1}`,
			values: x.map((_: string, i: number) => {
				const value = s.values[i];
				const num   = typeof value === 'number' ? value : value === null || value === undefined || value === '' ? NaN : Number(value);
				return Number.isFinite(num) ? num : null;
			}),
		}));
	if (x.length === 0 || series.length === 0) {
		return null;
	}
	return {
		type      : data.type,
		title     : typeof data.title === 'string' ? data.title : undefined,
		x,
		series,
		unit      : typeof data.unit === 'string' ? data.unit : undefined,
		horizontal: data.horizontal === true,
	};
}

const numberFormat = new Intl.NumberFormat(undefined, {maximumFractionDigits: 2});

function formatValue(value: number | null, unit?: string): string {
	if (value === null) {
		return '–';
	}
	return unit ? `${numberFormat.format(value)} ${unit}` : numberFormat.format(value);
}

function niceTicks(min: number, max: number, count: number = 5): number[] {
	if (min === max) {
		max = min === 0 ? 1 : min + Math.abs(min);
	}
	const rawStep         = (max - min) / count;
	const exponent        = Math.pow(10, Math.floor(Math.log10(rawStep)));
	const fraction        = rawStep / exponent;
	const step            = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * exponent;
	const ticks: number[] = [];
	for (let t = Math.floor(min / step) * step; t <= max + step * 0.5; t += step) {
		ticks.push(Math.abs(t) < step / 1e6 ? 0 : t);
	}
	return ticks;
}

/** Bar path with a 4px rounded data-end and a square end at the baseline. */
function barPath(x: number, y: number, width: number, height: number, horizontal: boolean, towardsPositive: boolean): string {
	const r = Math.min(4, (horizontal ? height : width) / 2, horizontal ? width : height);
	if (horizontal) {
		return towardsPositive
			? `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`
			: `M${x + width},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + height - r}Q${x},${y + height} ${x + r},${y + height}H${x + width}Z`;
	}
	return towardsPositive
		? `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`
		: `M${x},${y}V${y + height - r}Q${x},${y + height} ${x + r},${y + height}H${x + width - r}Q${x + width},${y + height} ${x + width},${y + height - r}V${y}Z`;
}

interface TooltipState {
	left: number;
	top: number;
	title: string;
	rows: Array<{ seriesIndex: number; name: string; value: number | null }>;
}

function ChartBlock({spec}: { spec: ChartSpec }): JSX.Element {
	const containerRef                  = useRef<HTMLDivElement>(null);
	const [width, setWidth]             = useState(640);
	const [showTable, setShowTable]     = useState(false);
	const [tooltip, setTooltip]         = useState<TooltipState | null>(null);
	const [activeIndex, setActiveIndex] = useState<number | null>(null);
	const {t}                           = useI18n();

	useEffect(() => {
		const element = containerRef.current;
		if (!element) {
			return;
		}
		const observer = new ResizeObserver((entries) => setWidth(Math.max(280, Math.floor(entries[0].contentRect.width))));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const allValues  = spec.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
	const dataMin    = Math.min(0, ...allValues);
	const dataMax    = Math.max(0, ...allValues);
	const ticks      = useMemo(() => niceTicks(dataMin, dataMax), [dataMin, dataMax]);
	const domainMin  = ticks[0];
	const domainMax  = ticks[ticks.length - 1];
	const horizontal = spec.type === 'bar' && (spec.horizontal || (spec.x.some((label) => label.length > 12) && spec.x.length <= 30));
	const showLegend = spec.series.length >= 2;

	const rows = spec.x.map((label, i) => ({
		label,
		values: spec.series.map((s, seriesIndex) => ({seriesIndex, name: s.name, value: s.values[i]})),
	}));

	const showTooltip = (event: { clientX: number; clientY: number }, index: number): void => {
		const rect = containerRef.current?.getBoundingClientRect();
		if (!rect) {
			return;
		}
		setActiveIndex(index);
		setTooltip({left: event.clientX - rect.left, top: event.clientY - rect.top, title: rows[index].label, rows: rows[index].values});
	};
	const hideTooltip = (): void => {
		setActiveIndex(null);
		setTooltip(null);
	};

	let plot: JSX.Element;
	let svgHeight: number;

	if (horizontal) {
		const labelWidth = Math.min(200, Math.max(60, Math.max(...spec.x.map((l) => l.length)) * 7));
		const groupSize  = spec.series.length * BAR_THICKNESS + (spec.series.length - 1) * BAR_GAP;
		const band       = groupSize + 14;
		const left       = labelWidth + 12;
		const right      = 24;
		const plotWidth  = width - left - right;
		const top        = 8;
		svgHeight        = top + band * spec.x.length + 28;
		const scale      = (v: number) => left + ((v - domainMin) / (domainMax - domainMin)) * plotWidth;
		plot             = (
			<g>
				{ticks.map((t) => (
					<g key={t}>
						<line x1={scale(t)} x2={scale(t)} y1={top} y2={svgHeight - 24} className={t === 0 ? 'chart-baseline' : 'chart-grid'}/>
						<text x={scale(t)} y={svgHeight - 8} textAnchor="middle" className="chart-tick">{numberFormat.format(t)}</text>
					</g>
				))}
				{rows.map((row, i) => {
					const bandTop = top + i * band + (band - groupSize) / 2;
					return (
						<g key={i}
						   className={activeIndex === i ? 'chart-band active' : 'chart-band'}
						   tabIndex={0}
						   onPointerMove={(e) => showTooltip(e, i)}
						   onPointerLeave={hideTooltip}
						   onFocus={(e) => {
							   const r = (e.currentTarget as SVGGElement).getBoundingClientRect();
							   showTooltip({clientX: r.left + r.width / 2, clientY: r.top}, i);
						   }}
						   onBlur={hideTooltip}>
							<rect x={0} y={top + i * band} width={width} height={band} className="chart-hit"/>
							<text x={labelWidth} y={top + i * band + band / 2} textAnchor="end" dominantBaseline="middle" className="chart-category">
								{row.label.length > 28 ? `${row.label.slice(0, 27)}…` : row.label}
							</text>
							{row.values.map(({seriesIndex, value}) => {
								if (value === null) {
									return null;
								}
								const x0 = scale(0);
								const x1 = scale(value);
								return (
									<path key={seriesIndex}
										  className={`chart-mark series-${seriesIndex + 1}`}
										  d={barPath(Math.min(x0, x1), bandTop + seriesIndex * (BAR_THICKNESS + BAR_GAP), Math.abs(x1 - x0), BAR_THICKNESS, true, value >= 0)}/>
								);
							})}
						</g>
					);
				})}
			</g>
		);
	} else {
		const left       = 56;
		const right      = spec.type === 'line' ? 16 : 8;
		const top        = 12;
		const plotWidth  = width - left - right;
		const bottom     = top + PLOT_HEIGHT;
		svgHeight        = bottom + 36;
		const scaleY     = (v: number) => top + (1 - (v - domainMin) / (domainMax - domainMin)) * PLOT_HEIGHT;
		const n          = spec.x.length;
		const step       = spec.type === 'line' ? plotWidth / Math.max(1, n - 1) : plotWidth / n;
		const xAt        = (i: number) => spec.type === 'line' ? left + (n === 1 ? plotWidth / 2 : i * step) : left + i * step + step / 2;
		const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotWidth / 90))));

		const grid = (
			<g>
				{ticks.map((t) => (
					<g key={t}>
						<line x1={left} x2={width - right} y1={scaleY(t)} y2={scaleY(t)} className={t === 0 ? 'chart-baseline' : 'chart-grid'}/>
						<text x={left - 8}
						      y={scaleY(t)}
						      textAnchor="end"
						      dominantBaseline="middle"
						      className="chart-tick">{numberFormat.format(t)}</text>
					</g>
				))}
				{spec.x.map((label, i) => (i % labelEvery === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= labelEvery / 2) ? (
					<text key={i}
					      x={xAt(i)}
					      y={bottom + 18}
					      textAnchor={spec.type === 'line' && i === 0 ? 'start' : spec.type === 'line' && i === n - 1 ? 'end' : 'middle'}
					      className="chart-tick">
						{label.length > 14 ? `${label.slice(0, 13)}…` : label}
					</text>
				) : null)}
			</g>
		);

		if (spec.type === 'bar') {
			const groupWidth = Math.min(step - 6, spec.series.length * BAR_THICKNESS + (spec.series.length - 1) * BAR_GAP);
			const barWidth   = Math.max(2, (groupWidth - (spec.series.length - 1) * BAR_GAP) / spec.series.length);
			plot             = (
				<g>
					{grid}
					{rows.map((row, i) => (
						<g key={i}
						   className={activeIndex === i ? 'chart-band active' : 'chart-band'}
						   tabIndex={0}
						   onPointerMove={(e) => showTooltip(e, i)}
						   onPointerLeave={hideTooltip}
						   onFocus={(e) => {
							   const r = (e.currentTarget as SVGGElement).getBoundingClientRect();
							   showTooltip({clientX: r.left + r.width / 2, clientY: r.top}, i);
						   }}
						   onBlur={hideTooltip}>
							<rect x={left + i * step} y={top} width={step} height={PLOT_HEIGHT} className="chart-hit"/>
							{row.values.map(({seriesIndex, value}) => {
								if (value === null) {
									return null;
								}
								const y0 = scaleY(0);
								const y1 = scaleY(value);
								const x  = xAt(i) - groupWidth / 2 + seriesIndex * (barWidth + BAR_GAP);
								return (
									<path key={seriesIndex}
										  className={`chart-mark series-${seriesIndex + 1}`}
										  d={barPath(x, Math.min(y0, y1), barWidth, Math.abs(y1 - y0), false, value >= 0)}/>
								);
							})}
						</g>
					))}
				</g>
			);
		} else {
			const nearestIndex = (clientX: number): number => {
				const rect = containerRef.current?.getBoundingClientRect();
				const px   = rect ? clientX - rect.left : 0;
				return Math.max(0, Math.min(n - 1, Math.round((px - left) / (n === 1 ? 1 : step))));
			};
			plot               = (
				<g onPointerMove={(e) => showTooltip(e, nearestIndex(e.clientX))} onPointerLeave={hideTooltip}>
					{grid}
					<rect x={left} y={top} width={plotWidth} height={PLOT_HEIGHT} className="chart-hit"/>
					{activeIndex !== null && (
						<line x1={xAt(activeIndex)} x2={xAt(activeIndex)} y1={top} y2={bottom} className="chart-crosshair"/>
					)}
					{spec.series.map((series, seriesIndex) => {
						const segments: string[] = [];
						let current              = '';
						series.values.forEach((value, i) => {
							if (value === null) {
								if (current) {
									segments.push(current);
								}
								current = '';
								return;
							}
							current += `${current ? 'L' : 'M'}${xAt(i)},${scaleY(value)}`;
						});
						if (current) {
							segments.push(current);
						}
						const lastIndex = series.values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0).pop();
						return (
							<g key={seriesIndex} className={`series-${seriesIndex + 1}`}>
								{segments.map((d, k) => <path key={k} d={d} className="chart-line"/>)}
								{lastIndex !== undefined && (
									<circle cx={xAt(lastIndex)} cy={scaleY(series.values[lastIndex] as number)} r={4} className="chart-dot"/>
								)}
								{activeIndex !== null && series.values[activeIndex] !== null && (
									<circle cx={xAt(activeIndex)} cy={scaleY(series.values[activeIndex] as number)} r={4} className="chart-dot"/>
								)}
							</g>
						);
					})}
				</g>
			);
		}
	}

	return (
		<figure className="chart-block" ref={containerRef}>
			<figcaption className="chart-header">
				<span className="chart-title">{spec.title}{spec.unit ? <span className="chart-unit"> ({spec.unit})</span> : null}</span>
				<button type="button" className="chart-toggle" onClick={() => setShowTable((v) => !v)}>
					{showTable ? t('chart.chart') : t('chart.table')}
				</button>
			</figcaption>
			{showLegend && !showTable && (
				<div className="chart-legend">
					{spec.series.map((s, i) => (
						<span key={i} className="chart-legend-item">
							<span className={`chart-key ${spec.type === 'line' ? 'line' : 'rect'} series-${i + 1}`}/>
							{s.name}
						</span>
					))}
				</div>
			)}
			{showTable ? (
				<div className="chart-table-wrapper">
					<table className="chart-table">
						<thead>
						<tr>
							<th/>
							{spec.series.map((s, i) => <th key={i}>{s.name}</th>)}
						</tr>
						</thead>
						<tbody>
						{rows.map((row, i) => (
							<tr key={i}>
								<td>{row.label}</td>
								{row.values.map((v) => <td key={v.seriesIndex}>{formatValue(v.value, spec.unit)}</td>)}
							</tr>
						))}
						</tbody>
					</table>
				</div>
			) : (
				<svg width={width} height={svgHeight} role="img" aria-label={spec.title || t('chart.chart')}>
					{plot}
				</svg>
			)}
			{tooltip && !showTable && (
				<div className="chart-tooltip" style={{left: Math.min(tooltip.left + 12, width - 180), top: Math.max(0, tooltip.top - 12)}}>
					<div className="chart-tooltip-title">{tooltip.title}</div>
					{tooltip.rows.map((row) => (
						<div key={row.seriesIndex} className="chart-tooltip-row">
							<span className={`chart-key line series-${row.seriesIndex + 1}`}/>
							<strong>{formatValue(row.value, spec.unit)}</strong>
							{spec.series.length > 1 && <span className="chart-tooltip-name">{row.name}</span>}
						</div>
					))}
				</div>
			)}
		</figure>
	);
}

function hastText(node: any): string {
	if (!node) {
		return '';
	}
	if (node.type === 'text') {
		return node.value ?? '';
	}
	return (node.children ?? []).map(hastText).join('');
}

/** `pre` renderer for react-markdown: ```chart blocks become charts, everything else renders as before. */
export function MarkdownPre({node, children, ...props}: any): JSX.Element {
	const code      = node?.children?.find((child: any) => child.tagName === 'code');
	const className = ([] as string[]).concat(code?.properties?.className ?? []).join(' ');
	if (/\blanguage-chart\b/.test(className)) {
		const raw  = hastText(code).trim();
		const spec = parseChartSpec(raw);
		if (spec) {
			return <ChartBlock spec={spec}/>;
		}
		if (!raw.endsWith('}')) {
			return <div className="chart-placeholder">Drawing chart…</div>;
		}
	}
	return <pre {...props}>{children}</pre>;
}
