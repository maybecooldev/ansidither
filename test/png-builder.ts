/**
 * A minimal PNG writer, used only by the tests.
 *
 * Building fixtures in code keeps the repository free of binary blobs and lets
 * each test state exactly the colour type, bit depth, and scanline filter it
 * wants to exercise.
 */

import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

export function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

export type ColorType = 0 | 2 | 3 | 4 | 6;

/**
 * Build a PNG from raw, already-packed scanline data.
 *
 * `raw` must be the exact bytes that go after the per-row filter byte; this
 * function prefixes every row with the filter type you pass.
 */
export function buildPng(options: {
	width: number;
	height: number;
	colorType: ColorType;
	bitDepth: number;
	raw: Buffer;
	filter?: number;
	/** Per-row filter types; overrides `filter` when given. */
	filters?: number[];
	palette?: Buffer;
	trns?: Buffer;
	interlace?: number;
	/** Use this as the decompressed IDAT stream verbatim, bypassing padding. */
	idatData?: Buffer;
}): Buffer {
	const { width, height, colorType, bitDepth, raw } = options;

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = bitDepth;
	ihdr[9] = colorType;
	ihdr[10] = 0; // compression
	ihdr[11] = 0; // filter method
	ihdr[12] = options.interlace ?? 0;

	// Deliberately tolerate a bad colour type or short `raw` so that tests can
	// hand the decoder invalid input and assert on *its* error.
	const { channels } = CHANNELS[colorType] ?? { channels: 4 };
	const bytesPerRow = Math.ceil((width * channels * bitDepth) / 8);

	const filters = options.filters ?? Array(height).fill(options.filter ?? 0);
	const filtered = Buffer.alloc(height * (bytesPerRow + 1));
	for (let y = 0; y < height; y++) {
		filtered[y * (bytesPerRow + 1)] = filters[y] ?? 0;
		raw.copy(
			filtered,
			y * (bytesPerRow + 1) + 1,
			Math.min(y * bytesPerRow, raw.length),
			Math.min((y + 1) * bytesPerRow, raw.length),
		);
	}

	return Buffer.concat([
		SIGNATURE,
		chunk('IHDR', ihdr),
		...(options.palette ? [chunk('PLTE', options.palette)] : []),
		...(options.trns ? [chunk('tRNS', options.trns)] : []),
		chunk('IDAT', deflateSync(options.idatData ?? filtered)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

const CHANNELS: Record<ColorType, { channels: number }> = {
	0: { channels: 1 },
	2: { channels: 3 },
	3: { channels: 1 },
	4: { channels: 2 },
	6: { channels: 4 },
};

/** Pack 8-bit samples into a scanline, for bit depths below 8. */
export function packRow(samples: number[], bitDepth: number): Buffer {
	if (bitDepth === 8) return Buffer.from(samples);
	const perByte = 8 / bitDepth;
	const out = Buffer.alloc(Math.ceil(samples.length / perByte));
	for (let i = 0; i < samples.length; i++) {
		const byte = Math.floor(i / perByte);
		const shift = 8 - bitDepth * ((i % perByte) + 1);
		const clear = ~(1 << shift) & 0xff;
		const mask = (1 << bitDepth) - 1;
		out[byte] = (out[byte]! & clear) | ((samples[i]! & mask) << shift);
	}
	return out;
}
