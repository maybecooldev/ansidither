/**
 * A PNG decoder built on Node's zlib.
 *
 * Covers what actually turns up in the wild: every colour type, bit depths 1
 * through 16, all five scanline filters, tRNS transparency, and CRC validation
 * on every chunk. Adam7 interlacing is rejected with a clear message rather
 * than decoded incorrectly.
 */

import { inflateSync } from 'node:zlib';

export type Bitmap = {
	width: number;
	height: number;
	/** RGBA, 4 bytes per pixel, row-major, no padding. */
	data: Uint8ClampedArray;
};

export class PngError extends Error {}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Bytes per complete pixel, for the colour types we decode at 8 bits or less. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf: Uint8Array, start: number, end: number): number {
	let c = 0xffffffff;
	for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function hasSignature(buf: Uint8Array): boolean {
	return SIGNATURE.every((b, i) => buf[i] === b);
}

/** Read width/height without decoding pixels -- used to size the output grid. */
export function readHeader(buf: Uint8Array): { width: number; height: number } {
	if (!hasSignature(buf)) throw new PngError('not a PNG file (bad signature)');
	if (buf.length < 24) throw new PngError('PNG is truncated');
	if (String.fromCharCode(...buf.subarray(12, 16)) !== 'IHDR') {
		throw new PngError('first chunk is not IHDR');
	}
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function decodePng(input: Uint8Array): Bitmap {
	const buf = input;
	if (!hasSignature(buf)) throw new PngError('not a PNG file (bad signature)');

	let offset = 8;
	let ihdr: {
		width: number; height: number; bitDepth: number; colorType: number; interlace: number;
	} | null = null;

	let palette: Uint8Array | null = null;
	let trns: Uint8Array | null = null;
	const idat: Uint8Array[] = [];

	while (offset + 8 <= buf.length) {
		const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		const length = view.getUint32(offset);
		const type = String.fromCharCode(...buf.subarray(offset + 4, offset + 8));
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;

		if (dataEnd + 4 > buf.length) throw new PngError(`truncated inside ${type} chunk`);

		const expected = view.getUint32(dataEnd);
		const actual = crc32(buf, offset + 4, dataEnd);
		if (expected !== actual) {
			throw new PngError(`CRC mismatch in ${type} chunk -- file is corrupt`);
		}

		const data = buf.subarray(dataStart, dataEnd);

		switch (type) {
			case 'IHDR':
				ihdr = {
					width: view.getUint32(dataStart),
					height: view.getUint32(dataStart + 4),
					bitDepth: data[8]!,
					colorType: data[9]!,
					interlace: data[12]!,
				};
				break;
			case 'PLTE': palette = data.slice(); break;
			case 'tRNS': trns = data.slice(); break;
			case 'IDAT': idat.push(data); break;
			case 'IEND': offset = buf.length; break;
			default: break; // ancillary chunk we do not need
		}

		offset = dataEnd + 4;
	}

	if (!ihdr) throw new PngError('no IHDR chunk');
	if (idat.length === 0) throw new PngError('no image data (IDAT)');

	const { width, height, bitDepth, colorType, interlace } = ihdr;
	if (width === 0 || height === 0) throw new PngError('zero-sized image');
	if (interlace !== 0) {
		throw new PngError('interlaced (Adam7) PNGs are not supported');
	}
	if (!(colorType in CHANNELS)) throw new PngError(`unknown colour type ${colorType}`);
	if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new PngError(`unsupported bit depth ${bitDepth}`);
	if (colorType === 3 && !palette) throw new PngError('palette image with no PLTE chunk');
	if ([2, 4, 6].includes(colorType) && bitDepth < 8) {
		throw new PngError(`bit depth ${bitDepth} is invalid for colour type ${colorType}`);
	}
	if (bitDepth < 8 && colorType !== 0 && colorType !== 3) {
		throw new PngError(`bit depth ${bitDepth} is invalid for colour type ${colorType}`);
	}

	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))));
	} catch (e) {
		throw new PngError(`could not decompress image data: ${(e as Error).message}`);
	}

	const channels = CHANNELS[colorType]!;
	const bitsPerPixel = channels * bitDepth;
	const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
	const bytesPerRow = Math.ceil((width * bitsPerPixel) / 8);

	if (raw.length < height * (bytesPerRow + 1)) {
		throw new PngError('image data is shorter than the header claims');
	}

	const pixels = unfilter(raw, width, height, bytesPerRow, bytesPerPixel);
	return toRgba(pixels, width, height, colorType, bitDepth, channels, bytesPerRow, palette, trns);
}

function unfilter(
	raw: Buffer,
	width: number,
	height: number,
	bytesPerRow: number,
	bpp: number,
): Uint8Array {
	const out = new Uint8Array(height * bytesPerRow);
	let pos = 0;

	for (let y = 0; y < height; y++) {
		const filter = raw[pos++]!;
		const rowStart = y * bytesPerRow;
		const prevStart = rowStart - bytesPerRow;

		for (let x = 0; x < bytesPerRow; x++) {
			const rawByte = raw[pos++]!;
			const a = x >= bpp ? out[rowStart + x - bpp]! : 0;
			const b = y > 0 ? out[prevStart + x]! : 0;
			const c = x >= bpp && y > 0 ? out[prevStart + x - bpp]! : 0;

			let value: number;
			switch (filter) {
				case 0: value = rawByte; break;
				case 1: value = rawByte + a; break;
				case 2: value = rawByte + b; break;
				case 3: value = rawByte + ((a + b) >> 1); break;
				case 4: value = rawByte + paeth(a, b, c); break;
				default: throw new PngError(`unknown scanline filter ${filter} on row ${y}`);
			}
			out[rowStart + x] = value & 0xff;
		}
	}
	return out;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

/** Extract the sample at bit offset `bit` from a packed row. */
function sampleAt(row: Uint8Array, index: number, bitDepth: number): number {
	if (bitDepth === 16) return row[index * 2]!; // take the high byte
	if (bitDepth === 8) return row[index]!;
	const perByte = 8 / bitDepth;
	const byte = row[Math.floor(index / perByte)]!;
	const shift = 8 - bitDepth * ((index % perByte) + 1);
	const mask = (1 << bitDepth) - 1;
	return (byte >> shift) & mask;
}

/** Scale an n-bit sample up to 8 bits. */
function scaleTo8(value: number, bitDepth: number): number {
	if (bitDepth === 8) return value;
	if (bitDepth === 16) return value;
	const max = (1 << bitDepth) - 1;
	return Math.round((value / max) * 255);
}

function toRgba(
	pixels: Uint8Array,
	width: number,
	height: number,
	colorType: number,
	bitDepth: number,
	channels: number,
	bytesPerRow: number,
	palette: Uint8Array | null,
	trns: Uint8Array | null,
): Bitmap {
	const data = new Uint8ClampedArray(width * height * 4);

	for (let y = 0; y < height; y++) {
		const row = pixels.subarray(y * bytesPerRow, y * bytesPerRow + bytesPerRow);

		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			const base = x * channels;

			switch (colorType) {
				case 0: { // greyscale
					const s = sampleAt(row, base, bitDepth);
					const g = scaleTo8(s, bitDepth);
					data[o] = data[o + 1] = data[o + 2] = g;
					// tRNS for greyscale is a 2-byte sample value that is
					// treated as fully transparent.
					const key = trns && trns.length >= 2 ? (trns[0]! << 8) | trns[1]! : null;
					data[o + 3] = key !== null && s === key ? 0 : 255;
					break;
				}
				case 2: { // truecolour
					data[o] = sampleAt(row, base, bitDepth);
					data[o + 1] = sampleAt(row, base + 1, bitDepth);
					data[o + 2] = sampleAt(row, base + 2, bitDepth);
					data[o + 3] = 255;
					break;
				}
				case 3: { // palette
					const idx = sampleAt(row, base, bitDepth);
					const p = idx * 3;
					data[o] = palette![p] ?? 0;
					data[o + 1] = palette![p + 1] ?? 0;
					data[o + 2] = palette![p + 2] ?? 0;
					data[o + 3] = trns && idx < trns.length ? trns[idx]! : 255;
					break;
				}
				case 4: { // greyscale + alpha
					const g = scaleTo8(sampleAt(row, base, bitDepth), bitDepth);
					data[o] = data[o + 1] = data[o + 2] = g;
					data[o + 3] = sampleAt(row, base + 1, bitDepth);
					break;
				}
				case 6: { // truecolour + alpha
					data[o] = sampleAt(row, base, bitDepth);
					data[o + 1] = sampleAt(row, base + 1, bitDepth);
					data[o + 2] = sampleAt(row, base + 2, bitDepth);
					data[o + 3] = sampleAt(row, base + 3, bitDepth);
					break;
				}
			}
		}
	}

	return { width, height, data };
}
