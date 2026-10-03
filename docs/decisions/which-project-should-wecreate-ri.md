# Decision: which project should we create right now?

Meeting: 2 rounds, 5 participants (Chair, Pragmatist, Skeptic, Simplifier, User advocate).
Date: 2026-10-02. Notes in `.meeting/`.

Every factual claim below was produced by **running the code**, not reading it.
Section 6 records the two places where that changed the answer.

---

## 1. The decision

**The question was wrong, and that is the decision.** Four colleagues proposed
four different projects. Every one of them was reasonable. None of them should
be built yet, because this repo is one commit old and **two of its three entry
points are broken**, while its default output mode emits malformed escape
sequences.

We are not creating a project. We are finishing one that was started and never
run.

### Batch A — make it installable and make it correct. ~1 day. One PR.

**A1. Repair the installed binary.** `npm install ansidither` yields a binary that
crashes. Verified by packing, installing and running:

```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently
unsupported for files under node_modules, for ".../node_modules/ansidither/src/cli.ts"
```

Node refuses to strip types under `node_modules`, and `bin` points at
`src/cli.ts`. **`NODE_OPTIONS=--experimental-strip-types` does not rescue it** —
verified; same crash. Fix is a ~15-line `src/run.js` launcher using
`module.registerHooks` + `stripTypeScriptTypes`. No dependencies, no build step.

**A2. Repair the clone-and-go path.** `src/cli.ts` is committed `100644` with a
`#!/usr/bin/env node` shebang. Fresh clone → `./src/cli.ts` → `permission denied`
(reproduced from a clean `git clone`). Fix is `git update-index --chmod=+x`.
The README's headline promise is false today.

**A3. Fix the three missing ESC bytes** — `render.ts:73,85,89`. The two reset
lines (78, 101) *do* carry `\x1b`; the three SGR lines do not. Verified: default
mode emits `[48;2;170;0;0m` — a literal bracket. Colour is the **default** mode,
and `▀` half-blocks carry no information without colour, so the default path is
broken, not degraded. **Verified that this one fix alone restores correct output**
and leaves 39/39 tests green — it is a genuine one-line-per-site fix with no
hidden coupling. Use `const ESC = '\x1b'`, never a literal byte.

**A4. Guard `-l`.** `-l` is the **only** numeric flag `cli.ts` never validates,
while it validates `width`, `height`, `mode` and `dither`. All verified:

| Input | Actual behaviour |
|---|---|
| `-l 7` (colour) | **Silent corruption.** `nearestIndex` returns 285 for grey 212; `Uint8Array` stores 29; renders `[0,170,42.5]` — **green where the image is grey** |
| `-l 5` | `[48;2;191.25;63.75;63.75m` — fractional SGR components |
| `-g -l 1` | `[48;2;NaN;NaN;NaNm` — `grayRamp(1)` divides by zero |
| `-l 0` | Silently renders at the default (`o.levels \|\| 4`) — a typo is invisible |
| `-l -1` | Raw `TypeError` + file paths, where the CLI's established style is `ansidither: width must be between 1 and 2000` |
| `-l 100` | **Hangs** — timed out at 60s on a 200×200. `nearestIndex` is a linear scan over `levels³` colours per pixel |

**The exact bounds, computed not guessed** (section 7): colour `-l` accepts
**2–6**; grayscale accepts **2–256**. Reject non-integers, `< 2`, and out-of-range
with a clean `fail()`.

**A5. Make the failure mode visible.** The suite is **39/39 green with the default
mode broken** — both facts verified in one run. The cause is structural: the only
escape assertions use `assert.doesNotMatch(out, /^[\[/)`, which asserts the
*absence* of an escape, so a **missing** ESC passes them trivially. Nothing
asserts a colour escape is *present and correct*. Add (a) a flat-colour round-trip
asserting an exact `\x1b[38;2;…m`, (b) `test/cli.test.ts`, which does not exist —
no test imports `cli.ts`, and every A4 bug lives there, (c) the Simplifier's
one-liner: flat grey at `-l 7` must not emit a non-grey.

**A6. Add CI.** There is no `.github/`. Green tests are currently a local claim,
not a gate.

### Batch B — the first real feature. ~half a day. Separate PR, after A merges.

**Truecolor: render the true 24-bit image — no palette, no quantisation, no
dithering.**

### Batch C — its own block, with a real estimate before anyone starts.

**Adam7 interlacing.** The README's one "Not handled" item.

### Standing: not JPEG, ever, absent a separate decision

It ends the project's defining constraint (no dependencies, clone and go).

---

## 2. Why this order, and not the four proposals

All four colleagues independently argued **against creating a new project**, from
four different directions, and they are the reason this document is not a feature
pick. They did not agree on what to do instead — that is the part worth reading.

- **The Pragmatist's distribution finding outranks every bug we found.** I found
  the broken default mode and thought that was first. It isn't. Two of three entry
  points are broken, which caps the project's reach at **one** — you can only run
  it from inside a source checkout. A correct tool nobody can install is worth
  less than a broken one they can, and this is ~1 hour against the rest of Batch A.
- **The Skeptic's and Simplifier's `-l` finding outranks my ESC finding.** They
  found it; I missed it, and my R1 note claimed `-l` bugs were "behind an unusual
  flag" and therefore lower priority than the ESC bytes. The `-l 7` wrap is **silent
  wrong output with no error signal** — the worst failure mode in the tool. My
  ranking put the loud bug (malformed text you can see) above the quiet one
  (a plausible picture in the wrong colours), which was backwards. Both are in
  Batch A regardless, but the correction is the substance of section 6.1.
- **The User advocate's input layer is real and well-framed** — "the image is
  already in your clipboard" is the true precondition, and `fetch`/`stdin` are
  zero-dep so it cannot break the README's best sentence. It lost on sequencing
  only: it adds a way to *feed* the tool, and we still cannot *start* it. Same
  reason truecolor waits. **Not rejected on merit — scheduled behind A.**
- **Batch A is one PR, ~1 day.** The four proposals were each individually
  reasonable and collectively additive; taking them in sequence is how a one-commit
  repo becomes a six-commit one with all of its entry points still broken.

---

## 3. Options that lost, and why

- **Input plumbing (stdin / URLs / terminal width / `--max-bytes`)** — User
  advocate. Lost on sequencing. Nothing to pipe *into* a tool that won't launch.
  Its runner-up, **JPEG/WebP**, was endorsed by its own author as a genuinely
  larger project and stays out.
- **Truecolor ahead of A1/A2** — my own R1 position, conceded. Fixing fidelity on
  a binary that crashes at `npm install` is building the house before the door.
- **Widening `indices` to `Uint16Array`** — the Skeptic raised it as a real choice
  and is right that it deserves 30 minutes of thought. **Rejected**, for a reason
  the Skeptic also supplied: `nearestIndex` is a linear scan over the palette per
  pixel, so a wider palette is a quadratic cliff, not a free win. Cap and validate.
- **Adam7 now** — three of us argued against it. Real gap, bounded, spec-defined —
  but it helps only a user who already *has* an interlaced file, and the README
  already rejects it with a clear message rather than silently misdecoding.
- **A refactor / new architecture** — nobody proposed it, and nobody objected to
  the current architecture. It is fine. Leave it.

---

## 4. The `-l 7` fix, precisely — because "widen the array" is wrong here

Three colleagues converged on `Uint8Array` overflow as the bug. It is real, but
it is **not the only bug wearing that flag**, and a partial fix leaves the others:

- **Overflow** (`indices` is `Uint8Array`, `-l 7` → 343 colours): cap at 6.
- **Fractional SGR** (`-l 5` → `191.25`): independent of overflow — `-l 3` and
  `-l 5` produce no overflow but emit fractional components. Round in `rgbCube`.
- **`grayRamp(1)` NaN**: independent again. Guard separately.
- **Unbounded `-l 100`**: not a correctness bug at all, a performance cliff.

Capping at 6 and rounding closes all four at once. Widening the buffer closes one.
**Do not let the array type define the flag's contract** — the contract should be
"every SGR component is an integer, and every index fits", and the cap is the
simplest way to guarantee both.

---

## 5. What the meeting got wrong about itself

- **The Chair's R1 ranking was wrong on priority**, and two colleagues found the
  thing the Chair missed. Recorded in full below, because the correction is more
  useful than the correction's absence would have been.
- **Nobody proposed CI**, and it should have been on the table by the first round.
  It is in Batch A on the Skeptic's argument alone.
- **Nobody ran `npm pack`.** The single most consequential defect in the project
  — the primary distribution path crashes on install — was invisible to all five
  of us until one person did a feasibility pass for an unrelated reason. Four bug
  reports and zero distribution reports, in a meeting about a CLI tool.

---

## 6. The two disputes, settled

### 6.1 The Chair missed the worst bug, and mis-ranked it

The Skeptic and Simplifier both reported `-l 7` silent colour corruption; the
Skeptic and Simplifier reached it independently. My R1 note said `-l` bugs "need
an unusual flag" and ranked them below the ESC bytes.

Both halves of that were wrong. `-l 7` is **silent** — it produces a
plausible-looking image in the wrong colours, which is strictly worse than
malformed text you can see in the terminal. And after re-verification I found the
`-l 7` case needed a specific colour to expose (grey 212, index 285; my first
test at grey 191 hit index 228 and did *not* wrap). Two careful people found it;
I, running code, walked past it. **The lesson is the process, not the attention.**

### 6.2 A prior decision doc's "ascii aspect ratio" bug does not exist

An earlier debate on this repo recorded an ascii-aspect bug as
sequencing-critical and proposed a fix. **It is not real.** Verified on a square
image: ascii `-w 80` → 40 rows; colour `-w 80` → 40 rows. Both physically square;
the `/2` at `cli.ts:150` is correct for both modes. The proposed fix would have
emitted ascii at 80×80 — a **2:1 stretched image**.

**Recorded so nobody re-raises it or "fixes" it into a real defect.**

---

## 7. Numbers that must not be left vague

Vague bounds are how these bugs ship. Computed, not estimated:

- **Colour `-l`: 2–6.** `rgbCube(6)` = 216 colours, inside `Uint8Array`.
  `rgbCube(7)` = 343, outside it. Among values a user would plausibly type, only
  **2, 4 and 6** produce all-integer SGR components (`step = 255/(L-1)`); `-l 3`
  and `-l 5` are broken today, not just `-l 7`. **Round in `rgbCube`; do not rely
  on the user picking an even count.**
- **Grayscale `-l`: 2–256.** `grayRamp` divides by `L-1`; `-l 1` is a division by
  zero, not a palette of one.
- **Rejects:** non-integers, `-l 0`, negative values, out-of-range — via the
  existing `fail()` style, not a thrown `TypeError`.
- **`-l 100` hanging** is the unbounded-scan cliff and is closed by the same cap.
  `nearestIndex` is O(levels³) per pixel; that is a performance property, not a
  correctness one, and must not be "fixed" by widening.

## 8. Still open

- **Whether to publish to npm, and under what name.** The User advocate's position:
  distribution is not capability — worth it at the second user, not the first. A1
  makes the package *installable*; it does not make it *published*. Undecided.
- **`engines.node`.** The A1 shim needs `module.registerHooks`, which is Node
  **22.15+**. The package currently claims `>=22.6`. The Pragmatist raised this
  cost honestly rather than hiding it; it is a real, deliberate narrowing of the
  support window and someone should choose it knowingly.
- **The Pragmatist's stated shim API was wrong, and the fix still works.** They
  wrote `stripTypeScriptTypes(src, 'strip')`; the real signature is
  `stripTypeScriptTypes(src, { mode: 'strip' })`, and `'strip'` is already the
  default. `registerHooks`' `load` must also return `shortCircuit: true` for `.ts`
  and delegate synchronously for everything else, or Node throws
  `ERR_INVALID_RETURN_PROPERTY_VALUE`. **I built the corrected shim and ran it
  against a real `npm install` — it produces correct half-block output.** Take
  the mechanism, not the code as pasted.
- **Adam7's estimate.** Nobody has produced one. Get a real number before Batch C.
- **Truecolor's interaction with `-l`.** Truecolor dissolves the palette on that
  path, which deletes most of the A4 bug class. Confirm during Batch B whether the
  `-l` flag should then be rejected in truecolor mode rather than silently ignored.
- **The README's "39 tests" claim was correct** — verified. Recorded so it isn't
  re-checked.
- **`files: ["src"]`** excludes tests from the npm tarball. This is normal and
  correct for publication; recorded only so it isn't re-raised as a packaging bug.

---

## 9. Summary

Four colleagues proposed four projects. The correct answer was to fix the one
that already exists — starting with a fact no one in the room had checked, and
that the Pragmatist found only because they tried to install their own tool.

**Batch A, ~1 day:** working installed binary, working clone-and-go, working
default mode, guarded `-l`, tests that can fail, CI.
**Batch B:** truecolor. **Batch C:** Adam7, after a real estimate.
**Not now:** any new project.