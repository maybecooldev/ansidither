#!/usr/bin/env node
/**
 * ansidither -- render a PNG in the terminal.
 *
 * Reads a PNG, picks a small palette, dithers down to it, and prints the result
 * as half-block characters. No dependencies; PNG decoding is built on Node's
 * own zlib.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { decodePng, readHeader, PngError } from './png.ts';
import { flatten, resize, toGray } from './image.ts';
import { dither, grayRamp, rgbCube, type DitherMethod } from './dither.ts';
import { render, type Mode } from './render.ts';

const USAGE = `ansidither -- render PNG images as terminal art

Usage
  ansidither <image.png> [options]

Options
  -w, --width <n>     output width in characters (default 80)
  -h, --height <n>    output height in rows; default keeps the aspect ratio
  -m, --mode <mode>   color (default) or ascii
  -d, --dither <how>  floyd (default), atkinson, ordered, or none
  -l, --levels <n>    palette size (default 6 grayscale, 4 per channel for colour)
  -g, --grayscale     force the grayscale ramp
  -b, --background <hex>  composite onto this colour (default 000000)
  -i, --invert        for terminals with a light background
      --no-color      never emit ANSI colour
  -o, --out <file>    write to a file instead of stdout
      --help          this text
`;

type Options = {
	files: string[];
	width: number;
	height: number | null;
	mode: Mode;
	dither: DitherMethod;
	levels: number;
	grayscale: boolean;
	background: string;
	invert: boolean;
	color: boolean;
	out: string | null;
	help: boolean;
};

function parseArgs(argv: string[]): Options {
	const o: Options = {
		files: [], width: 80, height: null, mode: 'color', dither: 'floyd',
		levels: 0, grayscale: false, background: '000000', invert: false,
		color: process.env.NO_COLOR ? false : true,
		out: null, help: false,
	};

	const need = (i: number, flag: string): string => {
		const v = argv[i];
		if (v === undefined) throw new Error(`${flag} needs a value`);
		return v;
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === '-w' || a === '--width') o.width = Number(need(++i, a));
		else if (a === '-h' || a === '--height') o.height = Number(need(++i, a));
		else if (a === '-m' || a === '--mode') o.mode = need(++i, a) as Mode;
		else if (a === '-d' || a === '--dither') o.dither = need(++i, a) as DitherMethod;
		else if (a === '-l' || a === '--levels') o.levels = Number(need(++i, a));
		else if (a === '-b' || a === '--background') o.background = need(++i, a);
		else if (a === '-o' || a === '--out') o.out = need(++i, a);
		else if (a === '-g' || a === '--grayscale') o.grayscale = true;
		else if (a === '-i' || a === '--invert') o.invert = true;
		else if (a === '--no-color') o.color = false;
		else if (a === '--help') o.help = true;
		else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
		else o.files.push(a);
	}
	return o;
}

function fail(message: string): never {
	process.stderr.write(`ansidither: ${message}\n`);
	process.exit(1);
}

function parseHex(hex: string): [number, number, number] {
	const h = hex.replace('#', '');
	if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`bad colour "${hex}", expected 6 hex digits`);
	return [
		parseInt(h.slice(0, 2), 16),
		parseInt(h.slice(2, 4), 16),
		parseInt(h.slice(4, 6), 16),
	];
}

function main(): void {
	let o: Options;
	try {
		o = parseArgs(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`ansidither: ${(e as Error).message}\nTry \`ansidither --help\`.\n`);
		process.exit(2);
	}

	if (o.help || o.files.length === 0) {
		process.stdout.write(USAGE);
		return;
	}

	const file = o.files[0]!;
	if (o.files.length > 1) fail('only one image at a time');

	let background: [number, number, number];
	try {
		background = parseHex(o.background);
	} catch (e) {
		fail((e as Error).message);
	}

	if (!Number.isInteger(o.width) || o.width < 1 || o.width > 2000) {
		fail('width must be between 1 and 2000');
	}
	if (o.height !== null && (!Number.isInteger(o.height) || o.height < 1)) {
		fail('height must be a positive integer');
	}
	if (!['color', 'ascii'].includes(o.mode)) fail(`unknown mode "${o.mode}"`);
	if (!['floyd', 'atkinson', 'ordered', 'none'].includes(o.dither)) {
		fail(`unknown dither "${o.dither}"`);
	}

	let bytes: Buffer;
	try {
		bytes = readFileSync(file);
	} catch {
		fail(`cannot read ${file}`);
	}

	let header: { width: number; height: number };
	try {
		header = readHeader(bytes);
	} catch (e) {
		fail(e instanceof PngError ? e.message : (e as Error).message);
	}

	// In colour mode each terminal row carries two pixels, so the target image
	// is twice as tall as the row count. Aspect follows from the source.
	const rows = o.height ?? Math.max(1, Math.round((o.width * header.height) / header.width / 2));
	const targetHeight = o.mode === 'color' ? rows * 2 : rows;

	let bitmap;
	try {
		bitmap = decodePng(bytes);
	} catch (e) {
		fail(e instanceof PngError ? e.message : (e as Error).message);
	}

	const scaled = resize(bitmap, o.width, targetHeight);
	const rgb = flatten(scaled, background);

	const useGray = o.grayscale || o.mode === 'ascii';
	const palette = useGray ? grayRamp(o.levels || 6) : rgbCube(o.levels || 4);

	// dither() always works in RGB, so a grayscale request is widened here.
	const source = useGray ? triple(toGray(rgb)) : rgb;
	const dithered = dither(
		Float32Array.from(source),
		o.width,
		targetHeight,
		palette,
		o.dither,
	);

	const out = render(dithered, { mode: o.mode, color: o.color, invert: o.invert });

	if (o.out) {
		writeFileSync(o.out, `${out}\n`, 'utf8');
	} else {
		process.stdout.write(`${out}\n`);
	}
}

/** Expand a single-channel buffer to RGB triplets so dither() sees one shape. */
function triple(gray: Float32Array): Float32Array {
	const out = new Float32Array(gray.length * 3);
	for (let i = 0; i < gray.length; i++) {
		out[i * 3] = gray[i]!;
		out[i * 3 + 1] = gray[i]!;
		out[i * 3 + 2] = gray[i]!;
	}
	return out;
}

main();
