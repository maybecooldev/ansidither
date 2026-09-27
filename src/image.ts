/**
 * Resizing.
 *
 * Downscaling a photograph to 80 columns means averaging away most of the
 * pixels, so a naive nearest-neighbour sample throws away detail and shimmers.
 * This uses box averaging over the source rectangle each output pixel covers,
 * with alpha-weighted colour so transparent edges do not bleed black into
 * their neighbours.
 */

import type { Bitmap } from './png.ts';

export type RGB = [number, number, number];

/** Average every source pixel in a `w` by `h` block into one RGB. */
export function resize(src: Bitmap, w: number, h: number): Bitmap {
	const out = new Uint8ClampedArray(w * h * 4);
	const xRatio = src.width / w;
	const yRatio = src.height / h;

	for (let y = 0; y < h; y++) {
		const y0 = Math.floor(y * yRatio);
		const y1 = Math.max(y0 + 1, Math.min(src.height, Math.ceil((y + 1) * yRatio)));

		for (let x = 0; x < w; x++) {
			const x0 = Math.floor(x * xRatio);
			const x1 = Math.max(x0 + 1, Math.min(src.width, Math.ceil((x + 1) * xRatio)));

			let r = 0, g = 0, b = 0, a = 0, weight = 0;

			for (let sy = y0; sy < y1; sy++) {
				for (let sx = x0; sx < x1; sx++) {
					const i = (sy * src.width + sx) * 4;
					const alpha = src.data[i + 3]! / 255;
					// Weight colour by alpha so transparent pixels do not
					// contribute their (usually black) RGB.
					r += src.data[i]! * alpha;
					g += src.data[i + 1]! * alpha;
					b += src.data[i + 2]! * alpha;
					a += src.data[i + 3]!;
					weight += alpha;
				}
			}

			const o = (y * w + x) * 4;
			const count = (x1 - x0) * (y1 - y0);
			if (weight > 0) {
				out[o] = r / weight;
				out[o + 1] = g / weight;
				out[o + 2] = b / weight;
			}
			out[o + 3] = a / count;
		}
	}

	return { width: w, height: h, data: out };
}

/** Composite the bitmap over a background colour, returning opaque RGB. */
export function flatten(bitmap: Bitmap, background: RGB): Float32Array {
	const out = new Float32Array(bitmap.width * bitmap.height * 3);
	for (let i = 0; i < bitmap.width * bitmap.height; i++) {
		const a = bitmap.data[i * 4 + 3]! / 255;
		for (let c = 0; c < 3; c++) {
			const src = bitmap.data[i * 4 + c]!;
			out[i * 3 + c] = src * a + background[c]! * (1 - a);
		}
	}
	return out;
}

export function toGray(rgb: Float32Array): Float32Array {
	const out = new Float32Array(rgb.length / 3);
	for (let i = 0; i < out.length; i++) {
		// Rec. 601 luma.
		out[i] = 0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!;
	}
	return out;
}
