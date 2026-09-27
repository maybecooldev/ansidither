/**
 * Terminal output.
 *
 * Colour mode paints U+2580 UPPER HALF BLOCK, using the foreground colour for
 * the top half of the cell and the background for the bottom. That packs two
 * vertical pixels into one character, which is exactly what fixes the aspect
 * ratio: terminal cells are about twice as tall as they are wide, so a square
 * image needs half as many rows as columns.
 *
 * Escape sequences are only emitted when the colour actually changes, which
 * cuts the output size by roughly two thirds on a real image.
 */

import type { Dithered } from './dither.ts';

export type Mode = 'color' | 'ascii';

/** Light to dark, for a terminal with a dark background. */
const RAMP = ' .:-=+*#%@';

export type RenderOptions = {
	mode: Mode;
	color: boolean;
	/** For dark terminals this is false; --invert flips it for light ones. */
	invert: boolean;
};

type RGB = [number, number, number];

export function render(d: Dithered, options: RenderOptions): string {
	const { width, height, indices, palette } = d;
	const at = (x: number, y: number): RGB => {
		const cx = Math.min(width - 1, Math.max(0, x));
		const cy = Math.min(height - 1, Math.max(0, y));
		return palette.colors[indices[cy * width + cx]!]!;
	};

	const rows = options.mode === 'color' ? Math.ceil(height / 2) : height;
	const lines: string[] = [];

	// Remember the last colour we set so we can skip redundant escapes.
	let lastFg = '';
	let lastBg = '';

	for (let row = 0; row < rows; row++) {
		const parts: string[] = [];

		for (let col = 0; col < width; col++) {
			if (options.mode === 'ascii') {
				const [r, g, b] = at(col, row);
				parts.push(rampChar(luma(r, g, b), options.invert));
				continue;
			}

			const fg = at(col, row * 2);
			const bg = at(col, row * 2 + 1);
			const fgKey = `${fg[0]},${fg[1]},${fg[2]}`;
			const bgKey = `${bg[0]},${bg[1]},${bg[2]}`;

			if (!options.color) {
				// Without colour, average the two halves so the cell still
				// carries the right amount of ink.
				parts.push(rampChar(luma(fg[0], fg[1], fg[2]) * 0.5 + luma(bg[0], bg[1], bg[2]) * 0.5, options.invert));
				continue;
			}

			let out = '';
			if (fgKey === bgKey) {
				// Same colour top and bottom: a solid block needs one code, not
				// two. Dithering makes this the common case, so it roughly
				// halves the output size.
				if (fgKey !== lastBg) {
					out += `[48;2;${bg[0]};${bg[1]};${bg[2]}m`;
					lastBg = fgKey;
				}
				// The foreground is still set from the previous cell; reset it
				// so it cannot bleed into the next one.
				out += '[39m';
				lastFg = '';
				parts.push(`${out}█`);
				continue;
			}

			if (fgKey !== lastFg) {
				out += `[38;2;${fg[0]};${fg[1]};${fg[2]}m`;
				lastFg = fgKey;
			}
			if (bgKey !== lastBg) {
				out += `[48;2;${bg[0]};${bg[1]};${bg[2]}m`;
				lastBg = bgKey;
			}
			parts.push(`${out}▀`);
		}

		lines.push(parts.join(''));
	}

	// Close whatever the last cell left open. Ascii mode never emits colour,
	// so there is nothing to reset.
	const needsReset = options.color && options.mode === 'color';
	return needsReset ? `${lines.join('\n')}[0m` : lines.join('\n');
}

function luma(r: number, g: number, b: number): number {
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function rampChar(l: number, invert: boolean): string {
	const v = invert ? 1 - l : l;
	return RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.round(v * (RAMP.length - 1))))];
}
