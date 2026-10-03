# Decision: which project should we build?

Meeting: 3 rounds, 2 colleagues. Date: 2026-10-02.
Participants: Chair, Pragmatist, Skeptic.
All notes in `.meeting/`.

**Nothing in this document was executed.** Bash was unavailable to all three of
us for the entire meeting, so every claim here comes from reading code and
inspecting raw bytes. Section 1 makes verification the first task, precisely
because of that.

---

## 1. The decision, in order

### Batch A — make the tool do what it says (~1 day). Ships whatever else we pick.

1. **Verify first.** `npm test`; render one image in colour mode; `cat -A` the
   output. ~20 min. A precondition, not a task — see section 4.
2. **Fix the three missing ESC bytes** (`render.ts:73,85,89`), via an explicit
   `const ESC = '\x1b'` rather than a literal byte. ~1h. Blocks the default mode.
3. **Fix the value bugs in one pass:** `Math.round` in `rgbCube`
   (`dither.ts:28`); reject `levels < 2` in `grayRamp` (`dither.ts:19`);
   cap `-l` at 6 in colour mode, 256 in grayscale; validate as an integer in
   `cli.ts`; reject `-l 0` rather than letting `o.levels || 4` silently
   substitute the default (`cli.ts:164`). ~1h.
4. **Tests:** positive round-trip colour assertion (a known flat colour must
   produce the exact expected escape — not merely "contains `\x1b[38;2;`", which
   passes on half-fixed code); `test/cli.test.ts` — the first test that runs
   `cli.ts` at all, covering parsing, bounds and exit codes. ~4h.
   Write the assertions with an explicit `\x1b`, not a literal byte.

### Batch B — first real feature (~half a day, same PR as Batch A)

**Truecolor mode: render the true 24-bit image — no palette, no quantisation,
no dithering.**

### Batch C — the next project after that (its own block, with a real estimate)

**Adam7 interlacing support.** The README's one "Not handled" item and the only
hard rejection in `png.ts:112`.

### Standing: not JPEG, ever, without a separate decision

It ends the project's defining constraint (no dependencies, clone and go). The
README's own argument for staying small settles this.

---

## 2. Why this order

The table converged without noticing what it converged around. Two colleagues
read `render.ts` closely enough to find `dither.ts:85` and `cli.ts:150`, and
**neither reported the missing ESC byte.** It is visible to `cat -A`, `grep -c
$'^\x1b'` and `xxd` — not a subtle bug. Two careful readers walked past it, which
says the problem is the review process, not anyone's care.

The missing byte breaks `-m color`, which is the **default** (`cli.ts:53`), and
`▀` half-blocks carry no information without colour. So the default path is
broken, not degraded. That outranks every other finding on the table: the `-l`
bugs need an unusual flag, this needs nothing.

Truecolor (Batch B) beat Adam7 (Batch C) because of expected value, not taste.
The palette is not only a bug source but a **fidelity ceiling on every render** —
and `-d none` is misleadingly named, meaning "no error diffusion", not "no
quantisation": output is still crushed to 64 colours. Adam7 unlocks files the
user may never encounter, gated behind having got an interlaced file; truecolor
improves every image on every run. It also dissolves the entire `-l` bug class
on that path — no palette, no indices, no `Uint8Array` overflow question.

Adam7 keeps its slot because it is genuinely the only thing that makes a real
file *fail outright*, it is bounded and spec-defined, and it fits the
no-dependency grain.

---

## 3. What was decided against, and why

- **Adam7 as the next project** — the Chair and Skeptic's R1 ranking. Lost to
  truecolor on un-gated value per hour. Not rejected on merit; scheduled third.
- **JPEG** — all three, independently, on the README's argument. It ends the
  no-dependency promise.
- **Widening `indices` to `Uint16Array`** — the Pragmatist's alternative on R1,
  and the Skeptic's point against it was decisive: the overflow and the
  fractional-SGR bug are **independent**. Widening closes only the overflow and
  leaves fractional RGB (`step = 255/342` for `-l 7`) still reaching an SGR
  string. Cap `-l` at 6 (cube = 216, already inside `Uint8Array`) **and** round.
- **A pre-emptive refactor or new architecture** — nobody proposed it, and the
  architecture drew no objection from anyone. It is fine. Leave it.

## 4. The two disputes I had to settle, and how

This section exists because the room deadlocked on both, and because the
resolution is what a later reader needs.

### 4.1 My own citation was wrong, and it mattered

The Skeptic challenged my transcription of the test regex. I was wrong, and in
an instructive way. The Skeptic read `/\[/` (no anchor); I wrote `/^\[/`; the
file actually contains `/\x1b\[/` — **with** an ESC byte and **without** `^`
(`od` on `test/image.test.ts:154`).

Their inference was right and it cuts against me: if it were anchored with `^`,
broken output beginning `[38;2;` would *fail* the assertion and the bug would be
caught, so "the suite is green anyway" would not hold. The conclusion survives;
my citation did not. The assertion passes on broken output because it is
**unanchored** — a missing ESC only makes output more escape-free.

Recorded because of the failure mode it guards against: if anyone ever "fixes"
that test by adding `^`, they will have removed the property that let the bug
through, without learning why it worked.

### 4.2 The ascii-aspect bug does not exist — and the "fix" would have created one

The Skeptic held this from R1 through R2 as "the only *shape* bug on the table,"
and made it sequencing-critical: it needs no unusual flag, so it corrupts every
ascii render. Both colleagues and I checked it against `cli.ts:150-151`:

- `rows = round(width · height / width / 2)`, then
  `targetHeight = mode === 'color' ? rows * 2 : rows`.
- **Colour:** target height `(W·H/w)/2 · 2` = `W·H/w`, and `render.ts:38` packs
  two pixels per row — so a square image is half as many rows as columns. Right.
- **Ascii:** target height `(W·H/w)/2`, one pixel per row — 40 rows for 80
  columns, which at ~2:1 cells is physically square. **Also right.**

Both modes are physically square. The `/2` is correct for both, and the Skeptic
read line 150 without line 151 compensating. Their proposed fix — drop the `/2`
and apply it only in colour mode — would have turned a non-bug into a real one,
emitting ascii at 80×80 characters, i.e. **a 2:1 stretched image**.

There is a real but milder asymmetry, inherent to one pixel per character and
not a defect: ascii discards half the vertical pixel density (40 px into 40 rows,
against colour's 80 px into 40 rows).

**Recorded so nobody "fixes" this later into a stretched image.**

## 5. Numbers that must not be left vague

- **`-l` bounds: 2–6 in colour mode (cube = 216, inside `Uint8Array`), 2–256 in
  grayscale. Reject `-l 0`, `-l 1`, and non-integers.** "A sensible cap" is how
  this bug ships. Note the constraint behind it: `levels-1` must divide 255 for
  the SGR components to be integers — among values anyone would type, only
  **2, 4 and 6** qualify. `-l 3` is broken today, not just 5 and 8. `Math.round`
  is the fix; a bigger buffer is not.
- **`-l 100` hangs**, because `nearestIndex` (`dither.ts:45`) is a linear scan
  over `levels³` colours per pixel. Same missing bound, not a separate project.

## 6. Still open

- **Everything in section 1 is unverified** until step 1 runs. If the runtime
  contradicts the byte inspection, step 2 changes shape and this document's
  ranking changes with it.
- **Adam7's estimate.** "80 lines" (Pragmatist) and "days" (Chair) are both
  unverified. The Skeptic's objection is recorded and accepted: the seven passes
  each have their own dimensions, so `bytesPerRow` differs per pass and the
  existing `unfilter()` does not drop in as-is. Get a real estimate before
  committing to Batch C.
- **The test-count claim in the README** ("39 tests") was never confirmed.
- **`files: ["src"]` in `package.json`** was raised as a packaging concern and
  found to be **a non-issue** — that field controls npm publication, and
  excluding tests from it is normal and correct. Recorded only so it isn't
  re-raised.
- **Whether to publish v1.0** was raised and not decided. It should follow
  Batch A + B, not precede them.

## 7. What this meeting got wrong about itself

Worth recording, because it is the most transferable thing here.

**Three readers, three unexecuted bug reports, and one of them non-existent** —
the Skeptic's ascii-aspect bug, which survived two rounds and nearly made it
into the plan as a sequencing-critical fix. Meanwhile two readers missed the
one bug that breaks the default mode, which was visible to a single `cat -A`.

Nobody was careless. The failures were structural: no one could run the code,
and the tests assert *absence* of escape codes, which is exactly the shape that
fails to catch a missing one. **A green suite was never evidence here, and the
first task of Batch A is the proof.** The Skeptic conceded a better finding
from the table; that was the right call and it is the reason this decision is
trustworthy rather than a three-way split.
