# T-024 — Human-like input

**Pillar:** Automation / stealth · **Assignee:** Claude · **Status:** done · **Day:** 7 (stealth polish)

Behavioral evasion: bots are given away by perfectly straight, instant mouse moves and metronomic
keystrokes. `@lobster/engine-runner`'s `humanize` module synthesises realistic motion and dispatches it
via CDP `Input.*`.

## What shipped — `packages/engine-runner/src/humanize.ts`

- **Pure, seeded generators** (unit-testable, reproducible with an explicit `seed`; a fresh random seed by
  default so repeats are never byte-identical):
  - `mousePath(from, to)` — a jittered cubic-Bézier bow, integer device-pixel coordinates, exact endpoints.
  - `moveTimings(hops)` — U-shaped per-hop delays (→ bell-shaped velocity over the evenly-sampled path).
  - `typingCadence(text)` — variable per-char delays with a "thinking" pause after punctuation.
- **CDP dispatch helpers** (injectable `sleep` for instant tests): `humanMouseMove`, `humanClick`, `humanType`.

## Adversarial review (all fixed before commit)

A focused review caught genuine correctness + detectability bugs in the first cut:
- **[HIGH]** every char was inserted **twice** (`keyDown`+`char`) → typing `abc` landed as `aabbcc`. Now one
  `keyDown` (with `text`) + `keyUp`, no `char` event.
- **[HIGH]** key events lacked `key`/`code`/`windowsVirtualKeyCode` → broke `keydown` listeners (Enter, shortcuts)
  and was an injection tell. Now populated per character.
- **[HIGH]** mouse press omitted the `buttons` bitmask → an impossible `button:0 && buttons:0` mousedown. Now
  `buttons:1` pressed / `0` released; moves are explicit hover (`button:'none'`, `buttons:0`).
- **[MED]** **sub-pixel** coordinates (real mouse events are integer — ironically *more* detectable) → now `Math.round`.
- **[MED]** content-derived default seeds made repeats byte-identical (replay tell) → per-call random default seed.
- **[LOW]** double easing (ease-in-space × ease-in-time) → linear path sampling + one easing in the timing.
- **[LOW]** skipped re-emitting the start pixel.

## Verification

- 8 unit tests (endpoints exact + integer coords, non-linear bow, deterministic, zero-length guard, U-shaped
  timing, punctuation pause, `buttons`/hover state, single-insert keystrokes with key/code). Full suite 131 green.

## Follow-ups

- Low-frequency **correlated tremor** + corrective sub-movements near the target (current jitter is uncorrelated
  white noise — acceptable for v1, but a determined behavioral model could still spot the self-similar curvature).
- Full `code`/`keyCode` map for punctuation/symbols (letters/digits/space/enter/tab are complete today).
- Wire `humanMouseMove`/`humanType` into the automation API as opt-in helpers.
