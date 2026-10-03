# ansidither

Turns a PNG into terminal art, with colour dithering.

```
$ ansidither plasma.png -w 60
```

No dependencies. PNG decoding is built on Node's own `zlib`, so this is a
`git clone` and go — no `node_modules`, no build step, nothing to compile.

Node 22.15 or newer is required either way; that is the version that can
strip TypeScript types from a `node_modules` install.

## Install

From a checkout, run the CLI in place:

```sh
./src/cli.ts image.png
```

Or install it as a command from that checkout:

```sh
npm install -g .
ansidither image.png
```

There is still nothing to build: the installed `ansidither` is a small
JavaScript launcher that hands `src/cli.ts` to Node's own type stripper. Node
prints an `ExperimentalWarning` about that API on each run; it is noise from
Node, not a failure, and the exit code is unaffected.

## Why half-blocks

Colour mode draws with `▀` (UPPER HALF BLOCK), which paints the foreground
colour in the top half of a cell and the background in the bottom. That packs
two vertical pixels into one character, and because terminal cells are about
twice as tall as they are wide, a square image needs half as many rows as
columns. The aspect ratio comes out right without any fudge factor.

## Use

```sh
ansidither image.png                      # 80 columns, colour, Floyd-Steinberg
ansidither image.png -w 120               # wider
ansidither image.png -h 40                # force a row count
ansidither image.png -m ascii             # no colour, for logs and plain text
ansidither image.png -d atkinson          # grainier, keeps local contrast
ansidither image.png -d none              # flat quantisation, no error diffusion
ansidither image.png -g -l 8              # grayscale, 8 levels
ansidither image.png -b 1a1a1a -i         # composite on light grey, inverted
ansidither image.png -o out.txt           # write to a file
```

`--no-color` forces plain output. `--invert` is for terminals with a light
background, where the default ramp reads backwards.

## Dithering

The terminal can show any colour, so this dithers to a deliberately small
palette. That is the point: a 4-level-per-channel RGB cube is 64 colours, and
error diffusion reconstructs the rest.

| Method | Behaviour |
|---|---|
| `floyd` | Floyd-Steinberg. The default; smooth, slightly soft. |
| `atkinson` | Discards a third of the error each step. Sharper and grainier, never smears. |
| `ordered` | Bayer 8x8 threshold matrix. Fast, regular, no error accumulation. |
| `none` | Straight nearest colour. Bands visibly, but produces the smallest output. |

Dithering costs bytes. A 60-column image is roughly 32 KB with `floyd` and
8 KB with `none`, because error diffusion makes neighbouring cells differ and
each colour change emits a new escape sequence. Escape codes are only written
when the colour actually changes, and a cell whose top and bottom halves are
the same colour collapses to one code, but a heavily dithered image will still
be verbose. If size matters more than smoothness, use `none` or `ordered`.

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

39 tests. The PNG fixtures are built in code by `test/png-builder.ts` rather than
committed as binaries, so each test can state exactly the colour type, bit depth
and filter it wants, and the repository stays free of opaque blobs. The filter
tests hand-check the arithmetic by hand, including the Paeth case where the
predictor picks the pixel above rather than the one to the left.

## Limits

- PNG only. No JPEG, because decoding JPEG properly is a much larger project
  than this one.
- Output size scales badly with dithering, as described above.
- Resizing is box-filtered with alpha-weighted colour. It looks good going
  down; it will not sharpen a genuinely low-resolution image.
