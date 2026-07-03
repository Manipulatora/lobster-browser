import { hashStringToUint32, mulberry32 } from '@lobster/fingerprint';
import type { CdpSession } from './cdp-fingerprint.js';

/**
 * Human-like input generation for the automation layer (MASTER_PLAN §5 "Human-like input").
 *
 * Bots are given away by perfectly straight, instantaneous mouse moves and metronomic keystrokes.
 * These helpers synthesise realistic motion — a jittered cubic-Bézier cursor path with bell-shaped
 * velocity, and a variable typing cadence with the occasional "thinking" pause — and dispatch them via
 * CDP `Input.*` events with protocol-correct button/key state.
 *
 * The path/timing generators are **pure** (seeded via the same mulberry32 PRNG the fingerprint engine
 * uses); pass an explicit `seed` for a reproducible result (tests do), else each call draws a fresh
 * random seed so repeated actions are never byte-identical (an identical replay is itself a bot tell).
 * Only the `human*` dispatch helpers touch a CDP session, and they take an injectable `sleep` so tests
 * run instantly.
 */

export interface Point {
  x: number;
  y: number;
}

/** Options common to the motion generators. `seed` makes the (otherwise random) jitter reproducible. */
export interface MousePathOptions {
  /** Number of segments; defaults to a distance-derived value (≈ dist/10, clamped 12–60). */
  steps?: number;
  /** Curve strength (perpendicular bow of the control points). 0 = straight, 1 = natural. */
  curve?: number;
  /** Peak per-point jitter in px (endpoints are never jittered). */
  jitter?: number;
  seed?: string;
}

export interface MoveTimingOptions {
  /** Total move duration in ms; defaults to a distance/steps-derived value. */
  totalMs?: number;
  seed?: string;
}

export interface TypingOptions {
  /** Median per-character delay in ms (actual delays vary ±40% around it). */
  baseMs?: number;
  seed?: string;
}

/** Deterministic float source in [0, 1) from a seed string. */
function rngFromSeed(seed: string): () => number {
  return mulberry32(hashStringToUint32(seed));
}

/**
 * Resolve the RNG seed: an explicit `seed` (reproducible — used by tests), or, by default, a per-call
 * random token. The random default is deliberate: a human never reproduces a motion/timing trace
 * exactly, so identical repeats (which a content-derived seed would produce) are themselves a tell.
 */
function autoSeed(base: string, seed?: string): string {
  return seed ?? `${base}:${Math.random().toString(36).slice(2)}`;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * US-layout physical key for each printable symbol: the `code` (never changes with Shift), the
 * `windowsVirtualKeyCode` of the underlying key, and whether the character requires Shift. Digits are
 * handled by the `[0-9]` branch in {@link keyInfo}; here we cover the shifted digits (`!@#…`) plus the
 * OEM punctuation keys in both their unshifted and shifted forms.
 */
const SYMBOL_KEYS: Record<string, { code: string; keyCode: number; shift: boolean }> = {
  '`': { code: 'Backquote', keyCode: 192, shift: false },
  '~': { code: 'Backquote', keyCode: 192, shift: true },
  '!': { code: 'Digit1', keyCode: 49, shift: true },
  '@': { code: 'Digit2', keyCode: 50, shift: true },
  '#': { code: 'Digit3', keyCode: 51, shift: true },
  $: { code: 'Digit4', keyCode: 52, shift: true },
  '%': { code: 'Digit5', keyCode: 53, shift: true },
  '^': { code: 'Digit6', keyCode: 54, shift: true },
  '&': { code: 'Digit7', keyCode: 55, shift: true },
  '*': { code: 'Digit8', keyCode: 56, shift: true },
  '(': { code: 'Digit9', keyCode: 57, shift: true },
  ')': { code: 'Digit0', keyCode: 48, shift: true },
  '-': { code: 'Minus', keyCode: 189, shift: false },
  _: { code: 'Minus', keyCode: 189, shift: true },
  '=': { code: 'Equal', keyCode: 187, shift: false },
  '+': { code: 'Equal', keyCode: 187, shift: true },
  '[': { code: 'BracketLeft', keyCode: 219, shift: false },
  '{': { code: 'BracketLeft', keyCode: 219, shift: true },
  ']': { code: 'BracketRight', keyCode: 221, shift: false },
  '}': { code: 'BracketRight', keyCode: 221, shift: true },
  '\\': { code: 'Backslash', keyCode: 220, shift: false },
  '|': { code: 'Backslash', keyCode: 220, shift: true },
  ';': { code: 'Semicolon', keyCode: 186, shift: false },
  ':': { code: 'Semicolon', keyCode: 186, shift: true },
  "'": { code: 'Quote', keyCode: 222, shift: false },
  '"': { code: 'Quote', keyCode: 222, shift: true },
  ',': { code: 'Comma', keyCode: 188, shift: false },
  '<': { code: 'Comma', keyCode: 188, shift: true },
  '.': { code: 'Period', keyCode: 190, shift: false },
  '>': { code: 'Period', keyCode: 190, shift: true },
  '/': { code: 'Slash', keyCode: 191, shift: false },
  '?': { code: 'Slash', keyCode: 191, shift: true },
};

/**
 * Key identity for a character's CDP key events. Real `keydown`/`keyup` listeners read `e.key` /
 * `e.code` / `e.keyCode` / `e.shiftKey`, not the inserted text, so we populate them: letters, digits,
 * space/enter/tab, and the US-layout punctuation in {@link SYMBOL_KEYS}. `shift` is true for the
 * characters produced with Shift held (uppercase letters and the shifted symbols) so
 * {@link humanType} can press Shift and tag the event modifiers — a shifted char with no Shift is a tell.
 */
function keyInfo(ch: string): { key: string; code: string; keyCode: number; shift: boolean } {
  if (/^[a-z]$/.test(ch)) {
    const upper = ch.toUpperCase();
    return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), shift: false };
  }
  if (/^[A-Z]$/.test(ch))
    return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), shift: true };
  if (/^[0-9]$/.test(ch))
    return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), shift: false };
  switch (ch) {
    case ' ':
      return { key: ' ', code: 'Space', keyCode: 32, shift: false };
    case '\n':
      return { key: 'Enter', code: 'Enter', keyCode: 13, shift: false };
    case '\t':
      return { key: 'Tab', code: 'Tab', keyCode: 9, shift: false };
  }
  const sym = SYMBOL_KEYS[ch];
  if (sym) return { key: ch, code: sym.code, keyCode: sym.keyCode, shift: sym.shift };
  return { key: ch, code: '', keyCode: 0, shift: false };
}

/**
 * A human-like cursor path from `from` to `to`: a cubic Bézier whose two control points are offset
 * perpendicular to the straight line by jittered amounts (a natural bow), sampled at LINEAR `t` (so
 * the velocity easing is applied exactly once — in {@link moveTimings} — not squared) with small
 * per-point jitter. Coordinates are integer device pixels (fractional coords never come from real
 * hardware). The first and last points are exactly `from`/`to`.
 */
export function mousePath(from: Point, to: Point, opts: MousePathOptions = {}): Point[] {
  const rand = rngFromSeed(autoSeed(`${from.x},${from.y}->${to.x},${to.y}`, opts.seed));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // Degenerate move: nowhere to travel, so emit just the endpoints (no jitter, no divide-by-zero).
  if (dist === 0) {
    return [
      { x: from.x, y: from.y },
      { x: to.x, y: to.y },
    ];
  }
  const steps = Math.max(2, opts.steps ?? Math.min(60, Math.max(12, Math.round(dist / 10))));
  const curve = opts.curve ?? 1;
  const jitter = opts.jitter ?? 1.2;

  const px = -dy / dist;
  const py = dx / dist;
  const off1 = (rand() - 0.5) * dist * 0.2 * curve;
  const off2 = (rand() - 0.5) * dist * 0.2 * curve;
  const c1: Point = { x: from.x + dx / 3 + px * off1, y: from.y + dy / 3 + py * off1 };
  const c2: Point = { x: from.x + (2 * dx) / 3 + px * off2, y: from.y + (2 * dy) / 3 + py * off2 };

  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    let x =
      mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * to.x;
    let y =
      mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * to.y;
    if (i !== 0 && i !== steps) {
      x += (rand() - 0.5) * jitter;
      y += (rand() - 0.5) * jitter;
    }
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  // Snap the endpoints exactly onto the targets (jitter/rounding must never move them).
  points[0] = { x: from.x, y: from.y };
  points[points.length - 1] = { x: to.x, y: to.y };
  return points;
}

/**
 * Per-hop delays (ms) for a move of `hops` segments. U-shaped: larger gaps near the ends (the hand
 * is slow to start and to settle) and smaller through the middle, with jitter — which, over the
 * evenly-sampled path, yields a bell-shaped velocity. The delays sum to ≈ `totalMs`.
 */
export function moveTimings(hops: number, opts: MoveTimingOptions = {}): number[] {
  const n = Math.max(1, hops);
  const rand = rngFromSeed(autoSeed(`move:${n}`, opts.seed));
  const total = opts.totalMs ?? Math.min(1200, Math.max(120, n * 12));
  const weights: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const u = n === 1 ? 0.5 : i / (n - 1);
    const bell = 1 + 1.5 * Math.pow(2 * u - 1, 2); // 1 mid → 2.5 at the ends
    weights.push(bell * (0.85 + 0.3 * rand()));
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => round2((w / sum) * total));
}

/**
 * Per-character delays (ms) for typing `text`: a variable cadence (±40% around `baseMs`) with an
 * added "thinking" pause after sentence punctuation and, occasionally, after a space.
 */
export function typingCadence(text: string, opts: TypingOptions = {}): number[] {
  const rand = rngFromSeed(autoSeed(`type:${text}`, opts.seed));
  const base = opts.baseMs ?? 95;
  const chars = [...text];
  return chars.map((ch, i) => {
    let d = base * (0.6 + 0.8 * rand());
    const prev = i > 0 ? chars[i - 1] : undefined;
    if (prev !== undefined && /[.,!?;:]/.test(prev)) {
      d += base * (1.5 + rand()); // pause after punctuation
    } else if (ch === ' ' && rand() < 0.15) {
      d += base * (1 + rand()); // occasional pause at a word boundary
    }
    return round2(d);
  });
}

/** Injectable sleep so the dispatch helpers can be driven instantly in tests. */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface HumanMoveOptions extends MousePathOptions, MoveTimingOptions {
  sleep?: Sleep;
}

/**
 * Move the cursor from `from` to `to` along a human-like path. `path[0]` is the cursor's current
 * position, so we don't re-emit it — each hop sleeps its travel time, then dispatches an
 * `Input.mouseMoved` (button `none`, `buttons` 0 — protocol-correct for a hover move). Returns `to`.
 */
export async function humanMouseMove(
  cdp: CdpSession,
  from: Point,
  to: Point,
  opts: HumanMoveOptions = {},
): Promise<Point> {
  const path = mousePath(from, to, opts);
  const timings = moveTimings(path.length - 1, opts);
  const sleep = opts.sleep ?? realSleep;
  for (let i = 1; i < path.length; i += 1) {
    await sleep(timings[i - 1] as number);
    const p = path[i] as Point;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: p.x,
      y: p.y,
      button: 'none',
      buttons: 0,
    });
  }
  return path[path.length - 1] as Point;
}

/**
 * Move to `to` then left-click with a short, realistic press duration. The `buttons` bitmask is set
 * correctly (1 while pressed, 0 on release) — a `button:0 && buttons:0` mousedown is impossible on
 * real hardware and a cheap detector check.
 */
export async function humanClick(
  cdp: CdpSession,
  from: Point,
  to: Point,
  opts: HumanMoveOptions = {},
): Promise<void> {
  const end = await humanMouseMove(cdp, from, to, opts);
  const sleep = opts.sleep ?? realSleep;
  const at = { x: end.x, y: end.y, button: 'left' as const, clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, buttons: 1 });
  await sleep(round2(40 + rngFromSeed(autoSeed(`click:${end.x},${end.y}`, opts.seed))() * 60));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, buttons: 0 });
}

/** CDP `Input.*` modifier bitmask for a held Shift key. */
const SHIFT_MODIFIER = 8;

/**
 * Type `text` with a human-like cadence. Each character is one `keyDown` (carrying `text`, which
 * inserts it once, plus `key`/`code`/`windowsVirtualKeyCode` so keydown listeners work) followed by a
 * `keyUp` — NOT a separate `char` event, which would double-insert the character.
 *
 * A shifted character (an uppercase letter or a shifted symbol) is produced exactly as real hardware
 * does: a `Shift` `keyDown` first, the char events tagged with the Shift modifier, then a `Shift`
 * `keyUp`. A bare shifted char with no Shift key event and `e.shiftKey === false` is a bot tell.
 */
export async function humanType(
  cdp: CdpSession,
  text: string,
  opts: TypingOptions & { sleep?: Sleep } = {},
): Promise<void> {
  const delays = typingCadence(text, opts);
  const sleep = opts.sleep ?? realSleep;
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string;
    const info = keyInfo(ch);
    const modifiers = info.shift ? SHIFT_MODIFIER : 0;
    if (info.shift) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Shift',
        code: 'ShiftLeft',
        windowsVirtualKeyCode: 16,
        modifiers: SHIFT_MODIFIER,
      });
    }
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      text: ch,
      modifiers,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      modifiers,
    });
    if (info.shift) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Shift',
        code: 'ShiftLeft',
        windowsVirtualKeyCode: 16,
      });
    }
    const gap = delays[i];
    if (gap !== undefined) {
      await sleep(gap);
    }
  }
}
