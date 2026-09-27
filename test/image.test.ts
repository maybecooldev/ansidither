import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resize, flatten, toGray, type RGB } from '../src/image.ts';
import { decodePng } from '../src/png.ts';
import { grayRamp, rgbCube, dither } from '../src/dither.ts';
import { render } from '../src/render.ts';
import { buildPng } from './png-builder.ts';

function solid(w: number, h: number, rgba: [number, number, number, number]) {
	const b = decodePng(buildPng({
		width: w, height: h, colorType: 6, bitDepth: 8,
		raw: Buffer.from(Array.from({ length: w * h }, () => rgba).flat()),
	}));
	return b;
}

test('resize to the same size is a no-op', () => {
	const src = solid(4, 4, [10, 20, 30, 255]);
	const out = resize(src, 4, 4);
	assert.equal(out.width, 4);
	assert.deepEqual([out.data[0], out.data[1], out.data[2], out.data[3]], [10, 20, 30, 255]);
});

test('resize averages when shrinking', () => {
	// Pixel 0 black, pixel 1 white; together they average to mid-grey.
	const src = solid(2, 1, [0, 0, 0, 255]);
	src.data[4] = 255;
	src.data[5] = 255;
	src.data[6] = 255;
	const out = resize(src, 1, 1);
	assert.equal(out.data[0], 128);
});

test('resize replicates when upscaling', () => {
	const src = solid(1, 1, [200, 100, 50, 255]);
	const out = resize(src, 3, 3);
	for (let i = 0; i < 9; i++) {
		assert.equal(out.data[i * 4], 200);
		assert.equal(out.data[i * 4 + 1], 100);
	}
});

test('transparent pixels do not drag their colour into the average', () => {
	// Left half opaque red, right half fully transparent but blue underneath.
	const src = solid(2, 1, [255, 0, 0, 255]);
	src.data[4] = 0; src.data[5] = 0; src.data[6] = 255; src.data[7] = 0;
	const out = resize(src, 1, 1);
	// Alpha-weighted, so the result is red, not a muddy purple.
	assert.ok(out.data[0]! > 240, `expected red-dominant, got ${out.data[0]}`);
});

test('flatten composites onto the background', () => {
	const src = solid(1, 1, [255, 255, 255, 0]);
	const rgb = flatten(src, [0, 0, 0] as RGB);
	assert.deepEqual([rgb[0], rgb[1], rgb[2]], [0, 0, 0]);
});

test('flatten keeps a half-transparent pixel halfway', () => {
	const src = solid(1, 1, [255, 255, 255, 128]);
	const rgb = flatten(src, [0, 0, 0] as RGB);
	assert.ok(rgb[0]! > 120 && rgb[0]! < 135, `expected ~128, got ${rgb[0]}`);
});

test('toGray uses luma weights', () => {
	const src = solid(1, 1, [255, 255, 255, 255]);
	assert.ok(Math.abs(toGray(flatten(src, [0, 0, 0] as RGB))[0]! - 255) < 0.001);
});

test('grayRamp spans black to white', () => {
	const p = grayRamp(5);
	assert.deepEqual(p.colors[0], [0, 0, 0]);
	assert.deepEqual(p.colors[4], [255, 255, 255]);
	assert.equal(p.colors.length, 5);
});

test('rgbCube has levels cubed entries and hits the corners', () => {
	const p = rgbCube(4);
	assert.equal(p.colors.length, 64);
	assert.deepEqual(p.colors[0], [0, 0, 0]);
	assert.deepEqual(p.colors[63], [255, 255, 255]);
});

test('nearestIndex finds the closest palette colour', () => {
	const p = grayRamp(5);
	assert.equal(p.colors[p.nearestIndex(0, 0, 0)]![0], 0);
	assert.equal(p.colors[p.nearestIndex(255, 255, 255)]![0], 255);
	assert.equal(p.colors[p.nearestIndex(60, 60, 60)]![0], 64);
});

test('dither maps a flat colour to a single palette index', () => {
	const w = 8, h = 8;
	const rgb = new Float32Array(w * h * 3).fill(128);
	const d = dither(Float32Array.from(rgb), w, h, grayRamp(4), 'none');
	const first = d.indices[0]!;
	for (const i of d.indices) assert.equal(i, first);
});

test('error diffusion actually moves error into later pixels', () => {
	const w = 16, h = 1;
	// A value that falls between two palette entries.
	const rgb = new Float32Array(w * 3).fill(200);
	const plain = dither(Float32Array.from(rgb), w, h, grayRamp(2), 'none');

	// dither() mutates the buffer it is given, so hold on to it.
	const buf = Float32Array.from(rgb);
	dither(buf, w, h, grayRamp(2), 'floyd');

	// The first pixel is untouched, but its residual is pushed right, so the
	// second pixel is no longer 200.
	assert.deepEqual(Array.from(buf.slice(0, 3)), [200, 200, 200]);
	assert.notDeepEqual(Array.from(buf.slice(3, 6)), [200, 200, 200]);
	assert.equal(plain.indices[0], 1);
});

test('dither never emits an out-of-range palette index', () => {
	const w = 32, h = 32;
	const rgb = new Float32Array(w * h * 3);
	for (let i = 0; i < w * h; i++) {
		rgb[i * 3] = (i * 7) % 256;
		rgb[i * 3 + 1] = (i * 13) % 256;
		rgb[i * 3 + 2] = (i * 29) % 256;
	}
	const p = rgbCube(4);
	for (const method of ['floyd', 'atkinson', 'ordered', 'none'] as const) {
		const d = dither(Float32Array.from(rgb), w, h, p, method);
		for (const idx of d.indices) {
			assert.ok(idx < p.colors.length, `index ${idx} out of range for ${method}`);
		}
	}
});

test('ordered dithering spreads a flat colour across two levels', () => {
	const w = 8, h = 8;
	const rgb = new Float32Array(w * h * 3).fill(128);
	const d = dither(Float32Array.from(rgb), w, h, grayRamp(2), 'ordered');
	assert.ok(new Set(d.indices).size > 1, 'ordered dithering should use more than one level');
});

test('colour mode renders half as many rows as pixels', () => {
	const w = 10, h = 20;
	const rgb = new Float32Array(w * h * 3).fill(100);
	const d = dither(Float32Array.from(rgb), w, h, grayRamp(4), 'floyd');
	const out = render(d, { mode: 'color', color: true, invert: false });
	assert.equal(out.split('\n').length, 10);
});

test('ascii mode renders one row per pixel', () => {
	const w = 10, h = 20;
	const rgb = new Float32Array(w * h * 3).fill(100);
	const d = dither(Float32Array.from(rgb), w, h, grayRamp(4), 'floyd');
	const out = render(d, { mode: 'ascii', color: false, invert: false });
	assert.equal(out.split('\n').length, 20);
	assert.doesNotMatch(out, /\[/);
});

test('no-color output contains no escape codes at all', () => {
	const w = 8, h = 8;
	const rgb = new Float32Array(w * h * 3).fill(90);
	const d = dither(Float32Array.from(rgb), w, h, rgbCube(4), 'floyd');
	for (const mode of ['color', 'ascii'] as const) {
		const out = render(d, { mode, color: false, invert: false });
		assert.doesNotMatch(out, /\[/, `${mode} leaked colour`);
	}
});

test('colour output always ends with a reset', () => {
	const w = 4, h = 4;
	const rgb = new Float32Array(w * h * 3).fill(90);
	const d = dither(Float32Array.from(rgb), w, h, rgbCube(4), 'floyd');
	const out = render(d, { mode: 'color', color: true, invert: false });
	assert.ok(out.endsWith('[0m'));
});

test('an odd pixel height still renders without throwing', () => {
	const w = 6, h = 7;
	const rgb = new Float32Array(w * h * 3).fill(70);
	const d = dither(Float32Array.from(rgb), w, h, rgbCube(4), 'floyd');
	const out = render(d, { mode: 'color', color: true, invert: false });
	assert.equal(out.split('\n').length, 4); // ceil(7/2)
});
