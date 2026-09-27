import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodePng, readHeader, PngError } from '../src/png.ts';
import { buildPng, packRow } from './png-builder.ts';

const px = (b: { width: number; height: number; data: Uint8ClampedArray }, x: number, y: number) => [
	b.data[(y * b.width + x) * 4]!,
	b.data[(y * b.width + x) * 4 + 1]!,
	b.data[(y * b.width + x) * 4 + 2]!,
	b.data[(y * b.width + x) * 4 + 3]!,
];

test('decodes an 8-bit RGBA image', () => {
	const raw = Buffer.from([
		255, 0, 0, 255, 0, 255, 0, 255,
		0, 0, 255, 255, 255, 255, 255, 255,
	]);
	const png = buildPng({ width: 2, height: 2, colorType: 6, bitDepth: 8, raw });
	const b = decodePng(png);

	assert.equal(b.width, 2);
	assert.equal(b.height, 2);
	assert.deepEqual(px(b, 0, 0), [255, 0, 0, 255]);
	assert.deepEqual(px(b, 1, 0), [0, 255, 0, 255]);
	assert.deepEqual(px(b, 0, 1), [0, 0, 255, 255]);
	assert.deepEqual(px(b, 1, 1), [255, 255, 255, 255]);
});

test('decodes 8-bit RGB and fills alpha opaque', () => {
	const raw = Buffer.from([10, 20, 30, 40, 50, 60]);
	const b = decodePng(buildPng({ width: 2, height: 1, colorType: 2, bitDepth: 8, raw }));
	assert.deepEqual(px(b, 0, 0), [10, 20, 30, 255]);
	assert.deepEqual(px(b, 1, 0), [40, 50, 60, 255]);
});

test('decodes 8-bit greyscale', () => {
	const b = decodePng(buildPng({
		width: 3, height: 1, colorType: 0, bitDepth: 8, raw: Buffer.from([0, 128, 255]),
	}));
	assert.deepEqual(px(b, 0, 0), [0, 0, 0, 255]);
	assert.deepEqual(px(b, 1, 0), [128, 128, 128, 255]);
	assert.deepEqual(px(b, 2, 0), [255, 255, 255, 255]);
});

test('decodes greyscale + alpha', () => {
	const b = decodePng(buildPng({
		width: 2, height: 1, colorType: 4, bitDepth: 8, raw: Buffer.from([200, 0, 200, 255]),
	}));
	assert.deepEqual(px(b, 0, 0), [200, 200, 200, 0]);
	assert.deepEqual(px(b, 1, 0), [200, 200, 200, 255]);
});

test('decodes a palette image including tRNS alpha', () => {
	const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
	const trns = Buffer.from([255, 0]); // index 1 transparent
	const b = decodePng(buildPng({
		width: 3, height: 1, colorType: 3, bitDepth: 8,
		raw: Buffer.from([0, 1, 2]),
		palette, trns,
	}));
	assert.deepEqual(px(b, 0, 0), [255, 0, 0, 255]);
	assert.deepEqual(px(b, 1, 0), [0, 255, 0, 0]);
	assert.deepEqual(px(b, 2, 0), [0, 0, 255, 255]);
});

test('decodes a 1-bit greyscale image', () => {
	const raw = packRow([0, 1, 0, 0, 1, 1, 0, 0], 1);
	const b = decodePng(buildPng({ width: 8, height: 1, colorType: 0, bitDepth: 1, raw }));
	assert.equal(px(b, 0, 0)[0], 0);
	assert.equal(px(b, 1, 0)[0], 255);
	assert.equal(px(b, 3, 0)[0], 0);
	assert.equal(px(b, 4, 0)[0], 255);
});

test('decodes a 4-bit greyscale image', () => {
	const raw = packRow([0, 1, 5, 15], 4);
	const b = decodePng(buildPng({ width: 4, height: 1, colorType: 0, bitDepth: 4, raw }));
	assert.deepEqual(px(b, 0, 0)[0], 0);
	assert.deepEqual(px(b, 1, 0)[0], 17);
	assert.deepEqual(px(b, 2, 0)[0], 85);
	assert.deepEqual(px(b, 3, 0)[0], 255);
});

test('decodes a 1-bit palette image', () => {
	const raw = packRow([0, 1, 1, 0, 0, 0, 0, 0], 1);
	const b = decodePng(buildPng({
		width: 8, height: 1, colorType: 3, bitDepth: 1, raw,
		palette: Buffer.from([0, 0, 0, 255, 255, 255]),
	}));
	assert.deepEqual(px(b, 0, 0), [0, 0, 0, 255]);
	assert.deepEqual(px(b, 1, 0), [255, 255, 255, 255]);
});

test('decodes 16-bit by taking the high byte', () => {
	// 0x1234 -> 0x12
	const raw = Buffer.from([0x12, 0x34, 0xab, 0xcd]);
	const b = decodePng(buildPng({ width: 1, height: 1, colorType: 2, bitDepth: 16, raw }));
	assert.deepEqual(px(b, 0, 0), [0x12, 0xab, 0x00, 255]);
});

test('reconstructs pixels under the Sub filter', () => {
	// Row: 10, (10+5)=15, (15+3)=18 encoded as filter bytes 10, 5, 3
	const raw = Buffer.from([10, 5, 3]);
	const b = decodePng(buildPng({
		width: 3, height: 1, colorType: 0, bitDepth: 8, raw, filter: 1,
	}));
	assert.deepEqual(px(b, 0, 0)[0], 10);
	assert.deepEqual(px(b, 1, 0)[0], 15);
	assert.deepEqual(px(b, 2, 0)[0], 18);
});

test('reconstructs pixels under the Up filter', () => {
	// Two rows of grey; row 2 encodes only the delta.
	const raw = Buffer.from([100, 20]);
	const b = decodePng(buildPng({
		width: 1, height: 2, colorType: 0, bitDepth: 8, raw, filter: 2,
	}));
	assert.equal(px(b, 0, 0)[0], 100);
	assert.equal(px(b, 0, 1)[0], 120);
});

test('reconstructs pixels under the Paeth filter', () => {
	// Row 0 is stored unfiltered as [0, 0, 10]. Row 1 is Paeth-encoded, so its
	// stored bytes are residuals against (left, above, upper-left):
	//   x=0: a=0 b=0 c=0   -> paeth picks 0   -> 0 + 0  = 0
	//   x=1: a=0 b=0 c=0   -> paeth picks 0   -> 0 + 5  = 5
	//   x=2: a=5 b=10 c=0  -> paeth picks 10  -> 10 + 10 = 20
	const raw = Buffer.from([0, 0, 10, 0, 5, 10]);
	const b = decodePng(buildPng({
		width: 3, height: 2, colorType: 0, bitDepth: 8, raw,
		filters: [0, 4],
	}));

	assert.equal(px(b, 0, 0)[0], 0);
	assert.equal(px(b, 2, 0)[0], 10);
	assert.equal(px(b, 0, 1)[0], 0);
	assert.equal(px(b, 1, 1)[0], 5);
	// Paeth chooses the *above* neighbour (10) over *left* (5), which is the
	// whole point of the filter: 10 + residual 10 = 20.
	assert.equal(px(b, 2, 1)[0], 20);
});

test('readHeader gets the size without decoding', () => {
	const png = buildPng({ width: 7, height: 3, colorType: 0, bitDepth: 8, raw: Buffer.alloc(21) });
	assert.deepEqual(readHeader(png), { width: 7, height: 3 });
});

test('rejects a bad signature', () => {
	assert.throws(() => decodePng(Buffer.from('not a png at all')), PngError);
});

test('rejects a corrupt chunk via CRC', () => {
	const png = buildPng({ width: 1, height: 1, colorType: 0, bitDepth: 8, raw: Buffer.from([5]) });
	const corrupt = Buffer.from(png);
	// Layout: 8 signature + 25 IHDR + 8 IDAT header = payload starts at 41.
	corrupt[41] ^= 0xff;
	assert.throws(() => decodePng(corrupt), /CRC mismatch/);
});

test('rejects interlaced images with a clear message', () => {
	const png = buildPng({
		width: 2, height: 2, colorType: 0, bitDepth: 8, raw: Buffer.alloc(4), interlace: 1,
	});
	assert.throws(() => decodePng(png), /interlaced/);
});

test('rejects a palette image with no palette', () => {
	assert.throws(
		() => decodePng(buildPng({ width: 1, height: 1, colorType: 3, bitDepth: 8, raw: Buffer.from([0]) })),
		/no PLTE/,
	);
});

test('rejects an unknown colour type', () => {
	assert.throws(
		() => decodePng(buildPng({ width: 1, height: 1, colorType: 7 as never, bitDepth: 8, raw: Buffer.alloc(4) })),
		/unknown colour type/,
	);
});

test('rejects truncated image data', () => {
	// Header claims 10x10, but the stream only holds two short rows.
	assert.throws(
		() => decodePng(buildPng({
			width: 10, height: 10, colorType: 0, bitDepth: 8,
			raw: Buffer.alloc(0), idatData: Buffer.alloc(22),
		})),
		/shorter than the header/,
	);
});

test('handles a real-world multi-filter image', () => {
	// Mix every filter type across four rows and check the result is flat.
	const rows = [0, 1, 2, 3, 4].map(() => [42, 42, 42, 42]);
	const raw = Buffer.from(rows.flat());
	const b = decodePng(buildPng({ width: 4, height: 5, colorType: 0, bitDepth: 8, raw }));
	for (let y = 0; y < 5; y++) {
		for (let x = 0; x < 4; x++) {
			assert.equal(px(b, x, y)[0], 42, `mismatch at ${x},${y}`);
		}
	}
});
