import ExcelJS from 'exceljs';
import {app, nativeImage} from 'electron';
import path from 'path';

const IMAGE_HEIGHT_PX      = 96;
const IMAGE_WIDTH_PX       = 100;
const IMAGE_COLUMN_WIDTH   = 15;
const IMAGE_FETCH_PARALLEL = 8;
const IMAGE_FETCH_TIMEOUT  = 20_000;
const MAX_COLUMN_WIDTH     = 60;
// Integers this long are codes (EAN, phone numbers): as numbers Excel would show them as 5.7E+12.
const MAX_NUMERIC_DIGITS   = 11;

export interface ExcelImages {
	/** Result column whose value is the key into `urlByKey`; its cells show the image instead. */
	column: string;
	urlByKey: Map<string, string>;
	onProgress?: (done: number, total: number) => void;
}

export interface ExcelExportResult {
	filePath: string;
	rowCount: number;
	imageCount: number;
	missingImageCount: number;
}

export function exportFilePath(baseName: string, extension: string): string {
	const safeBase = baseName.replace(new RegExp(`\\.${extension}$`, 'i'), '').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^[.\s]+/, '').slice(0, 80) || 'export';
	const now      = new Date();
	const stamp    = `${now.toISOString().slice(0, 10)}_${now.toTimeString().slice(0, 8).replace(/:/g, '-')}`;
	return path.join(app.getPath('downloads'), `${safeBase}_${stamp}.${extension}`);
}

export async function exportToExcelFile(
	baseName: string,
	rows: Array<Record<string, unknown>>,
	columns: string[],
	images?: ExcelImages,
): Promise<ExcelExportResult> {
	const filePath = exportFilePath(baseName, 'xlsx');
	const cols     = columns.length > 0 ? columns : Object.keys(rows[0] ?? {});
	const workbook = new ExcelJS.Workbook();
	const sheet    = workbook.addWorksheet(baseName.slice(0, 31).replace(/[\\/?*[\]:]/g, ' ') || 'Export', {
		views    : [{state: 'frozen', ySplit: 1}],
		pageSetup: {orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0},
	});

	const kinds      = cols.map((c): ColumnKind => c === images?.column ? 'image' : columnKind(rows.map((row) => row[c])));
	sheet.columns    = cols.map((c, i) => ({
		header: c,
		key   : c,
		width : kinds[i] === 'image' ? IMAGE_COLUMN_WIDTH : columnWidth(c, rows.map((row) => row[c])),
		style : {alignment: {vertical: 'middle'}, ...NUMBER_FORMATS[kinds[i]]},
	}));
	sheet.getRow(1).font = {bold: true};
	sheet.autoFilter     = {from: {row: 1, column: 1}, to: {row: 1, column: cols.length}};

	for (const row of rows) {
		sheet.addRow(cols.map((c, i) => {
			const value = row[c];
			if (kinds[i] === 'image' || value === null || value === undefined) {
				return null;
			}
			if (kinds[i] === 'integer' || kinds[i] === 'decimal') {
				return Number(value);
			}
			if (value instanceof Date || typeof value === 'number') {
				return value;
			}
			return Buffer.isBuffer(value) ? `<binary ${value.length} bytes>` : typeof value === 'object' ? JSON.stringify(value) : String(value);
		}));
	}

	let imageCount        = 0;
	let missingImageCount = 0;
	if (images) {
		const column    = cols.indexOf(images.column);
		const keys      = rows.map((row) => row[images.column] === null || row[images.column] === undefined ? '' : String(row[images.column]));
		const pictures  = await fetchImages(Array.from(new Set(keys.filter((k) => images.urlByKey.has(k)))), images);
		const imageIds  = new Map<string, { id: number; width: number; height: number }>();
		for (const [key, picture] of pictures) {
			imageIds.set(key, {id: workbook.addImage({buffer: picture.jpeg as unknown as ExcelJS.Buffer, extension: 'jpeg'}), ...picture});
		}
		keys.forEach((key, index) => {
			const image = imageIds.get(key);
			if (!image) {
				missingImageCount++;
				return;
			}
			imageCount++;
			sheet.getRow(index + 2).height = IMAGE_HEIGHT_PX * 0.75 + 6;
			sheet.addImage(image.id, {
				tl     : {col: column + 0.05, row: index + 1.05},
				ext    : {width: image.width, height: image.height},
				editAs : 'oneCell',
			});
		});
	}

	await workbook.xlsx.writeFile(filePath);
	return {filePath, rowCount: rows.length, imageCount, missingImageCount};
}

type ColumnKind = 'integer' | 'decimal' | 'date' | 'datetime' | 'image' | 'other';

const NUMBER_FORMATS: Partial<Record<ColumnKind, { numFmt: string }>> = {
	decimal : {numFmt: '#,##0.00'},
	date    : {numFmt: 'yyyy-mm-dd'},
	datetime: {numFmt: 'yyyy-mm-dd hh:mm'},
};

/** mysql2 returns DECIMAL and SUM() results as strings; they should be numbers in Excel. */
function columnKind(values: unknown[]): ColumnKind {
	const present = values.filter((value) => value !== null && value !== undefined && value !== '');
	if (present.length === 0) {
		return 'other';
	}
	if (present.every((value) => value instanceof Date)) {
		return present.every((value) => (value as Date).getHours() === 0 && (value as Date).getMinutes() === 0) ? 'date' : 'datetime';
	}
	let kind: ColumnKind = 'integer';
	for (const value of present) {
		const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
		if (/^-?(0|[1-9]\d*)$/.test(text) && text.replace('-', '').length <= MAX_NUMERIC_DIGITS) {
			continue;
		}
		if (/^-?(0|[1-9]\d*)\.\d+$/.test(text)) {
			kind = 'decimal';
			continue;
		}
		return 'other';
	}
	return kind;
}

function columnWidth(header: string, values: unknown[]): number {
	const longest = values.slice(0, 500).reduce<number>((max, value) => {
		const text = value instanceof Date ? 'yyyy-mm-dd hh:mm' : value === null || value === undefined ? '' : String(value);
		return Math.max(max, text.length);
	}, header.length);
	return Math.min(MAX_COLUMN_WIDTH, longest + 2);
}

async function fetchImages(keys: string[], images: ExcelImages): Promise<Map<string, { jpeg: Buffer; width: number; height: number }>> {
	const result = new Map<string, { jpeg: Buffer; width: number; height: number }>();
	let next     = 0;
	let done     = 0;
	const worker = async (): Promise<void> => {
		while (next < keys.length) {
			const key = keys[next++];
			try {
				const response = await fetch(images.urlByKey.get(key)!, {signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT)});
				if (response.ok && (response.headers.get('content-type') ?? '').startsWith('image/')) {
					const picture = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
					if (!picture.isEmpty()) {
						const original = picture.getSize();
						const scale    = Math.min(IMAGE_WIDTH_PX / original.width, IMAGE_HEIGHT_PX / original.height);
						const width    = Math.max(1, Math.round(original.width * scale));
						const height   = Math.max(1, Math.round(original.height * scale));
						// Stored at twice the shown size, so the picture stays sharp when zoomed or printed.
						const resized  = picture.resize({width: width * 2, height: height * 2, quality: 'better'});
						result.set(key, {jpeg: resized.toJPEG(85), width, height});
					}
				}
			} catch {
				// A missing picture leaves its cell empty; the caller reports how many are missing.
			}
			images.onProgress?.(++done, keys.length);
		}
	};
	await Promise.all(Array.from({length: Math.min(IMAGE_FETCH_PARALLEL, keys.length)}, worker));
	return result;
}
