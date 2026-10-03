# ansidither

Turns a PNG into terminal art, with colour dithering.

```sh
$ node src/cli.ts plasma.png -w 60
```

No dependencies. PNG decoding is built on Node's own `zlib`, so there is
nothing to install and nothing to compile: no `node_modules`, no build step.
The CLI is TypeScript run directly, so it needs a Node with built-in type
stripping — a recent Node 22 or newer. `package.json` declares the supported
range in `engines`; the commands below are verified on Node 26.

## Install

ansidither is not published to npm, so there is nothing to install globally
yet. Clone the repo and run the CLI in place:

```sh
git clone https://github.com/maybecooldev/ansidither.git
cd ansidither
node src/cli.ts image.png
```

Invoking it through `node` is deliberate. `src/cli.ts` carries a `#!/usr/bin/env
node` shebang, but it is committed without the executable bit set, so
`./src/cli.ts` from a fresh clone gives "permission denied" on current `main`.
Running it via `node` works everywhere and does not depend on that.

There is no `npm install` step: the package has no dependencies, so `npm test`
runs straight from a clean checkout.

## Use

```sh
node src/cli.ts image.png                      # 80 columns, colour, Floyd-Steinberg
node src/cli.ts image.png -w 120               # wider
node src/cli.ts image.png -h 40                # force a row count
node src/cli.ts image.png -m ascii             # no colour, for logs and plain text
node src/cli.ts image.png -d atkinson          # grainier, keeps local contrast
node src/cli.ts image.png -d none              # flat quantisation, no error diffusion
node src/cli.ts image.png -g -l 8              # grayscale, 8 levels
node src/cli.ts image.png -b 1a1a1a -i         # composite on light grey, inverted
node src/cli.ts image.png -o out.txt           # write to a file
```

`--no-color` forces plain output. `--invert` is for terminals with a light
background, where the default ramp reads backwards.

### Levels

`-l` sets the palette size, and the two modes accept different ranges:

| Mode | Accepted | Default |
|---|---|---|
| Colour (`levels` cubed, so `-l 6` is 216 colours) | 2-6 | 4 |
| Grayscale (`-g`, or `-m ascii`) | 2-256 | 6 |

Colour is bounded at 6 because the palette is stored as one byte per pixel, so
7 or more silently overflows it and produces wrong colours rather than an
error. Grayscale takes a much wider range because a ramp is a single channel.

Anything outside those ranges, or a non-integer like `-l 5.5`, should be
rejected with a clear error instead of rendering. That guard is not in place
yet: today `-l 5` in colour mode emits fractional escape codes such as
`38;2;63.75;...`, which no terminal can display. Stick to the ranges above.

## Why half-blocks

Colour mode draws with `▀` (UPPER HALF BLOCK), which paints the foreground
colour in the top half of a cell and the background in the bottom. That packs
two vertical pixels into one character, and because terminal cells are about
twice as tall as they are wide, a square image needs half as many rows as
columns. The aspect ratio comes out right without any fudge factor.

## Dithering

The terminal can show any colour, so this dithers to a deliberately small
palette. That is the point: a 4-level-per-channel RGB cube is 64 colours, and
error diffusion reconstructs the rest.

| Method | Behaviour |
|---|---|
| `floyd` | Floyd-Steinberg. The default; smooth, slightly soft. |
| `atkinson` | Discards a quarter of the error each step. Sharper and grainier, never smears. |
| `ordered` | Bayer 8x8 threshold matrix. Fast, regular, no error accumulation. |
| `none` | Straight nearest colour. Bands visibly, but produces the smallest output. |

Dithering costs bytes. On a photographic image, a 60-column render is about
47 KB with `floyd` and about 14 KB with `none`, because error diffusion makes
neighbouring cells differ and each colour change emits a new escape sequence.
Escape codes are only written when the colour actually changes, and a cell
whose top and bottom halves are the same colour collapses to one code, but a
heavily dithered image will still be verbose. If size matters more than
smoothness, use `none` or `ordered`.

## PNG support

Handled: colour types 0, 2, 3, 4 and 6; bit depths 1, 2, 4, 8 and 16; all five
scanline filters; `tRNS` transparency for palette and greyscale images; CRC
validation on every chunk, so a corrupt file reports itself instead of
producing garbage pixels.

Not handled: Adam7 interlacing. It is rejected with a clear message rather than
decoded incorrectly. Most screenshots and exports are not interlaced; if you hit
one, re-saving without interlacing fixes it.

## Tests

```sh
npm test
```

The suite covers PNG decoding across every supported colour type and bit depth,
each scanline filter including the Paeth case where the predictor picks the
pixel above rather than the one to the left, the rejection paths for corrupt
and unsupported files, resizing and flattening, palette construction, all four
dither methods, and rendering in both modes.

The PNG fixtures are built in code by `test/png-builder.ts` rather than
committed as binaries, so each test can state exactly the colour type, bit depth
and filter it wants, and the repository stays free of opaque blobs.

## Limits

- PNG only. No JPEG, because decoding JPEG properly is a much larger project
  than this one.
- Output size scales badly with dithering, as described above.
- Resizing is box-filtered with alpha-weighted colour. It looks good going
  down; it will not sharpen a genuinely low-resolution image.
