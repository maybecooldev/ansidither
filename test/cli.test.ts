/**
 * End-to-end tests for the CLI.
 *
 * These spawn the real binary rather than importing it: src/cli.ts ends in a
 * top-level main() that calls process.exit, so importing it would take the test
 * runner down with it. The fixtures are built in code with buildPng, as the
 * rest of the suite does.
 *
 * The motivation for most of these is that `--levels` used to be the one
 * numeric flag the CLI never validated, so it reached the palette builders
 * unchecked. The interesting failure was not a crash but silence: a colour cube
 * with more entries than a Uint8Array can index wrapped around and painted a
 * flat grey image green without any error at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPng } from './png-builder.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

// src/cli.ts honours NO_COLOR, so a runner with it set would suppress colour and
// make every SGR assertion below pass for the wrong reason.
const ENV = { ...process.env, NO_COLOR: undefined };

// A dithered 200x200 render is over the 1 MiB spawnSync default.
const MAX_BUFFER = 64 * 1024 * 1024;

const TIMEOUT = 30_000;

const dir = mkdtempSync(join(tmpdir(), 'ansidither-cli-'));

test.after(() => rmSync(dir, { recursive: true, force: true }));

/** A flat, opaque, 8-bit RGB PNG. */
function flatPng(name: string, w: number, h: number, rgb: [number, number, number]): string {
	const raw = Buffer.alloc(w * h * 3);
	for (let i = 0; i < w * h; i++) {
		raw[i * 3] = rgb[0];
		raw[i * 3 + 1] = rgb[1];
		raw[i * 3 + 2] = rgb[2];
	}
	const path = join(dir, name);
	writeFileSync(path, buildPng({ width: w, height: h, colorType: 2, bitDepth: 8, raw }));
	return path;
}

// 212 is the interesting grey: at -l 7 it lands on cube index 285, which is
// exactly where the Uint8Array truncation used to corrupt it. 191 does not,
// so a test using it would pass whether or not the bug was fixed.
const GREY = flatPng('grey212.png', 16, 16, [212, 212, 212]);
const BIG = flatPng('big.png', 200, 200, [212, 212, 212]);

function cli(args: string[]): SpawnSyncReturns<string> {
	const result = spawnSync(process.execPath, [CLI, ...args], {
		encoding: 'utf8',
		env: ENV,
		timeout: TIMEOUT,
		maxBuffer: MAX_BUFFER,
	});
	// A timeout leaves status null and surfaces as result.error, which would
	// otherwise sail through the "did it exit cleanly?" assertions below.
	assert.equal(result.error, undefined, `CLI did not finish: ${result.error?.message}`);
	return result;
}

/**
 * True 24-bit SGR colour sequences: `38;2;r;g;b` for foreground, `48;2;...`
 * for background.
 *
 * The leading ESC is optional because src/render.ts currently drops it on most
 * sequences (a separate bug, tracked on its own). Matching it either way keeps
 * these assertions about what the CLI should emit, so they stay correct once
 * that lands. Character classes exclude newlines so a malformed sequence cannot
 * swallow the next row, and the quantifiers are lazy so the last group stops at
 * this sequence's own terminator rather than running on to a later `m`.
 */
const SGR = /\x1b?\[(?:38|48);2;([^;\n]*?);([^;\n]*?);([^;\n]*?)m/g;

function sgrTriples(output: string): [string, string, string][] {
	return [...output.matchAll(SGR)].map((m) => [m[1]!, m[2]!, m[3]!]);
}

/** A rejected --levels: non-zero exit, one clean line, nothing rendered. */
function expectCleanFailure(args: string[], message: RegExp): SpawnSyncReturns<string> {
	const result = cli([GREY, '-w', '8', ...args]);
	assert.notEqual(result.status, 0, `expected a non-zero exit, got 0 (stdout: ${result.stdout.slice(0, 80)})`);
	assert.match(result.stderr, message);
	// One line, not a dump.
	assert.equal(result.stderr.trimEnd().split('\n').length, 1, `expected one line, got: ${result.stderr}`);
	// No Node stack frames -- this is what a raw TypeError looks like.
	assert.doesNotMatch(result.stderr, /^\s+at /m);
	assert.doesNotMatch(result.stderr, /\bat .*:\d+:\d+/);
	// No absolute paths leaked into a user-facing error.
	assert.doesNotMatch(result.stderr, /\/(home|Users|private)\//);
	assert.doesNotMatch(result.stderr, /\/tmp\//);
	// A rejected palette must not also have painted something.
	assert.equal(result.stdout, '', 'nothing should be rendered when --levels is rejected');
	return result;
}

test('rejects a colour level count that overflows the palette index', () => {
	// 7^3 = 343 entries, but dither() stores indices in a Uint8Array, so 285
	// wrapped to 29 and flat grey came out as [48;2;0;170;42.5m -- green.
	const result = expectCleanFailure(['-l', '7'], /^ansidither: levels must be an integer between 2 and 6$/m);
	assert.equal(result.status, 1);
});

test('rejects level counts outside the colour range', () => {
	for (const bad of ['1', '0', '-1', '3.5', '100', 'abc', '1e400', '0x10']) {
		expectCleanFailure(['-l', bad], /^ansidither: levels must be an integer between 2 and 6$/m);
	}
});

test('rejects a level count of 1 in grayscale, which divides by zero', () => {
	// grayRamp divides by levels-1, so 1 used to emit [48;2;NaN;NaN;NaNm
	// rather than fail.
	expectCleanFailure(['-g', '-l', '1'], /^ansidither: levels must be an integer between 2 and 256$/m);
});

test('applies the grayscale range to ascii mode too', () => {
	expectCleanFailure(['-m', 'ascii', '-l', '1'], /^ansidither: levels must be an integer between 2 and 256$/m);
	expectCleanFailure(['-m', 'ascii', '-l', '257'], /^ansidither: levels must be an integer between 2 and 256$/m);
});

test('rejects grayscale levels above 256', () => {
	expectCleanFailure(['-g', '-l', '257'], /^ansidither: levels must be an integer between 2 and 256$/m);
});

test('a colour level count large enough to hang no longer does', () => {
	// nearestIndex is a linear scan over levels^3 colours per pixel, so 100
	// meant 1e6 comparisons per pixel and never finished. It is now rejected
	// before any of that work starts.
	const result = cli([BIG, '-w', '200', '-h', '200', '-l', '100']);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /levels must be an integer between 2 and 6/);
});

test('the largest legal grayscale palette still completes', () => {
	// 256 is legal in grayscale and is the worst case that is allowed to run,
	// so this pins that the bound is 256 rather than a blanket refusal.
	const result = cli([BIG, '-w', '200', '-h', '200', '-g', '-l', '256']);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.stdout.length > 0);
});

test('accepts every colour level count in range', () => {
	for (const good of ['2', '3', '4', '5', '6']) {
		const result = cli([GREY, '-w', '8', '-l', good]);
		assert.equal(result.status, 0, `-l ${good} failed: ${result.stderr}`);
		assert.ok(result.stdout.length > 0);
	}
});

test('accepts grayscale levels across its range, including odd counts', () => {
	for (const good of ['2', '6', '7', '100', '256']) {
		const result = cli([GREY, '-w', '8', '-g', '-l', good]);
		assert.equal(result.status, 0, `-g -l ${good} failed: ${result.stderr}`);
	}
});

test('an omitted level count keeps the per-mode default', () => {
	for (const args of [[], ['-g'], ['-m', 'ascii']]) {
		const result = cli([GREY, '-w', '8', ...args]);
		assert.equal(result.status, 0, `default failed for [${args}]: ${result.stderr}`);
		assert.ok(result.stdout.length > 0);
	}
});

test('every SGR component is an integer in range, at every accepted level count', () => {
	// Covers 3 and 5 on purpose: they are inside the 2-6 range but divide 255
	// evenly only by accident, so they are the cases that used to emit
	// fractional channels such as 127.5.
	for (const levels of ['2', '3', '4', '5', '6']) {
		for (const args of [['-l', levels], ['-g', '-l', levels]]) {
			const result = cli([GREY, '-w', '8', ...args]);
			assert.equal(result.status, 0, result.stderr);

			const triples = sgrTriples(result.stdout);
			// Guard against a vacuous pass: with no triples every assertion
			// below would hold trivially.
			assert.ok(triples.length > 0, `no SGR emitted for [${args}] -- assertions would be meaningless`);

			for (const [r, g, b] of triples) {
				for (const c of [r, g, b]) {
					assert.match(c, /^\d{1,3}$/, `non-integer SGR component "${c}" for [${args}]`);
					assert.ok(Number(c) >= 0 && Number(c) <= 255, `SGR component out of range: ${c}`);
				}
			}
		}
	}
});

test('flat grey stays flat grey at every accepted level count', () => {
	for (const levels of ['2', '3', '4', '5', '6']) {
		const result = cli([GREY, '-w', '8', '-l', levels]);
		assert.equal(result.status, 0, result.stderr);

		const triples = sgrTriples(result.stdout);
		assert.ok(triples.length > 0, `no SGR emitted for -l ${levels}`);

		for (const [r, g, b] of triples) {
			// The corruption this guards against painted grey as green.
			assert.equal(r, g, `-l ${levels} made grey non-grey: ${r},${g},${b}`);
			assert.equal(g, b, `-l ${levels} made grey non-grey: ${r},${g},${b}`);
		}
		assert.doesNotMatch(result.stdout, /NaN/);
	}
});

test('flat grey stays flat grey in grayscale, at the extremes of the range', () => {
	for (const levels of ['2', '100', '256']) {
		const result = cli([GREY, '-w', '8', '-g', '-l', levels]);
		assert.equal(result.status, 0, result.stderr);

		const triples = sgrTriples(result.stdout);
		assert.ok(triples.length > 0, `no SGR emitted for -g -l ${levels}`);

		for (const [r, g, b] of triples) {
			assert.equal(r, g, `-g -l ${levels} made grey non-grey: ${r},${g},${b}`);
			assert.equal(g, b, `-g -l ${levels} made grey non-grey: ${r},${g},${b}`);
		}
		assert.doesNotMatch(result.stdout, /NaN/);
	}
});

test('the grayscale palette has no more colours than the index array can hold', () => {
	// The 2-256 bound exists because dither() fills a Uint8Array of palette
	// indices; 256 grey entries is the largest that fits without wrapping.
	const result = cli([GREY, '-w', '8', '-g', '-l', '256']);
	assert.equal(result.status, 0, result.stderr);
	// 256 levels puts one colour per possible 8-bit grey, so a flat grey image
	// should resolve to exactly that grey -- and to only that colour.
	const triples = [...new Set(sgrTriples(result.stdout))];
	assert.deepEqual(triples, [['212', '212', '212']]);
});