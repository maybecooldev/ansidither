/**
 * Dithering.
 *
 * The terminal can show any colour, so "dithering" here means choosing a small
 * fixed palette and then using error diffusion to fake the colours in between.
 * With a 6-level grey ramp the error diffusion is what keeps a gradient from
 * banding; with the RGB cube it keeps faces from turning into flat patches.
 */

export type Palette = {
	colors: [number, number, number][];
	/** Index of the palette colour closest to (r, g, b), by perceived distance. */
	nearestIndex(r: number, g: number, b: number): number;
};

export function grayRamp(levels: number): Palette {
	const colors: [number, number, number][] = [];
	for (let i = 0; i < levels; i++) {
		const v = Math.round((i * 255) / (levels - 1));
		colors.push([v, v, v]);
	}
	return makePalette(colors);
}

/** A coarse RGB cube: `levels` steps per channel. */
export function rgbCube(levels: number): Palette {
	const colors: [number, number, number][] = [];
	const step = levels > 1 ? 255 / (levels - 1) : 0;
	for (let r = 0; r < levels; r++) {
		for (let g = 0; g < levels; g++) {
			for (let b = 0; b < levels; b++) {
				// Round, so an odd level count cannot leak a fractional channel
				// into an SGR sequence, which terminals reject or misparse.
				colors.push([Math.round(r * step), Math.round(g * step), Math.round(b * step)]);
			}
		}
	}
	return makePalette(colors);
}

function makePalette(colors: [number, number, number][]): Palette {
	return {
		colors,
		nearestIndex(r, g, b) {
			let best = Infinity;
			let bestIdx = 0;
			for (let i = 0; i < colors.length; i++) {
				const c = colors[i]!;
				const dr = r - c[0];
				const dg = g - c[1];
				const db = b - c[2];
				// Weights approximate perceived difference.
				const d = 0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db;
				if (d < best) {
					best = d;
					bestIdx = i;
				}
			}
			return bestIdx;
		},
	};
}

export type DitherMethod = 'none' | 'floyd' | 'atkinson' | 'ordered';

export type Dithered = {
	width: number;
	height: number;
	/** Palette index per pixel. */
	indices: Uint8Array;
	palette: Palette;
};

/**
 * Map an RGB float buffer to palette indices.
 *
 * `rgb` is mutated as error diffuses through it, so pass a copy if you still
 * need the original.
 */
export function dither(
	rgb: Float32Array,
	width: number,
	height: number,
	palette: Palette,
	method: DitherMethod,
): Dithered {
	const indices = new Uint8Array(width * height);
	const nearestIndex = palette.nearestIndex;

	const at = (x: number, y: number, c: number): number => rgb[(y * width + x) * 3 + c]!;
	const set = (x: number, y: number, c: number, v: number): void => {
		if (x < 0 || x >= width || y < 0 || y >= height) return;
		rgb[(y * width + x) * 3 + c] = v;
	};

	// Bayer 8x8 ordered matrix, normalised to 0..1.
	const BAYER = [
		[0, 32, 8, 40, 2, 34, 10, 42],
		[48, 16, 56, 24, 50, 18, 58, 26],
		[12, 44, 4, 36, 14, 46, 6, 38],
		[60, 28, 52, 20, 62, 30, 54, 22],
		[3, 35, 11, 43, 1, 33, 9, 41],
		[51, 19, 59, 27, 49, 17, 57, 25],
		[15, 47, 7, 39, 13, 45, 5, 37],
		[63, 31, 55, 23, 61, 29, 53, 21],
	];

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = y * width + x;
			let r = at(x, y, 0);
			let g = at(x, y, 1);
			let b = at(x, y, 2);

			if (method === 'ordered') {
				// Push the sample around by the threshold offset.
				const threshold = (BAYER[y % 8]![x % 8]! + 0.5) / 64;
				const spread = 255 / Math.max(2, Math.cbrt(palette.colors.length));
				r += (threshold - 0.5) * spread;
				g += (threshold - 0.5) * spread;
				b += (threshold - 0.5) * spread;
			}

			const idx = nearestIndex(r, g, b);
			indices[i] = idx;
			if (method === 'none' || method === 'ordered') continue;

			const target = palette.colors[idx]!;
			const er = r - target[0];
			const eg = g - target[1];
			const eb = b - target[2];

			if (method === 'floyd') {
				// Floyd-Steinberg: full error, spread over 4 neighbours.
				set(x + 1, y, 0, at(x + 1, y, 0) + er * 7 / 16);
				set(x + 1, y, 1, at(x + 1, y, 1) + eg * 7 / 16);
				set(x + 1, y, 2, at(x + 1, y, 2) + eb * 7 / 16);

				set(x - 1, y + 1, 0, at(x - 1, y + 1, 0) + er * 3 / 16);
				set(x - 1, y + 1, 1, at(x - 1, y + 1, 1) + eg * 3 / 16);
				set(x - 1, y + 1, 2, at(x - 1, y + 1, 2) + eb * 3 / 16);

				set(x, y + 1, 0, at(x, y + 1, 0) + er * 5 / 16);
				set(x, y + 1, 1, at(x, y + 1, 1) + eg * 5 / 16);
				set(x, y + 1, 2, at(x, y + 1, 2) + eb * 5 / 16);

				set(x + 1, y + 1, 0, at(x + 1, y + 1, 0) + er * 1 / 16);
				set(x + 1, y + 1, 1, at(x + 1, y + 1, 1) + eg * 1 / 16);
				set(x + 1, y + 1, 2, at(x + 1, y + 1, 2) + eb * 1 / 16);
			} else if (method === 'atkinson') {
				// Atkinson discards a third of the error, which keeps local
				// contrast -- it can look grainy, but it never smears.
				for (const [dx, dy] of [[1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]] as const) {
					set(x + dx, y + dy, 0, at(x + dx, y + dy, 0) + er / 8);
					set(x + dx, y + dy, 1, at(x + dx, y + dy, 1) + eg / 8);
					set(x + dx, y + dy, 2, at(x + dx, y + dy, 2) + eb / 8);
				}
			}
		}
	}

	return { width, height, indices, palette };
}
