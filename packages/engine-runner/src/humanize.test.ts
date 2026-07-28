import assert from 'node:assert/strict';
import test from 'node:test';
import {
  humanClick,
  humanDrag,
  humanMouseMove,
  humanType,
  mousePath,
  moveTimings,
  typingCadence,
  type CdpSession,
  type Point,
} from './lib.js';

/** Records CDP sends so we can assert the exact Input event sequence without a browser. */
class RecordingCdp implements CdpSession {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push(params === undefined ? { method } : { method, params });
    return {};
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.calls
      .filter((c) => (c.params?.type ?? '') === type)
      .map((c) => c.params as Record<string, unknown>);
  }
}

const noSleep = async (): Promise<void> => {};

/** Perpendicular distance of point p from the line through a→b (how far the path bows off-straight). */
function deviationFromLine(a: Point, b: Point, p: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
}

test('mousePath starts and ends exactly on the targets', () => {
  const from = { x: 10, y: 20 };
  const to = { x: 400, y: 300 };
  const path = mousePath(from, to, { seed: 'p1' });
  assert.deepEqual(path[0], from);
  assert.deepEqual(path[path.length - 1], to);
  assert.ok(path.length >= 13, `expected a multi-point path, got ${path.length}`);
});

test('mousePath is deterministic per seed and varies across seeds', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 500, y: 120 };
  assert.deepEqual(mousePath(from, to, { seed: 's' }), mousePath(from, to, { seed: 's' }));
  assert.notDeepEqual(mousePath(from, to, { seed: 'a' }), mousePath(from, to, { seed: 'b' }));
});

test('mousePath is non-linear (bows off the straight line) — not a robotic straight drag', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 600, y: 0 };
  const path = mousePath(from, to, { seed: 'curve', curve: 1 });
  const maxDeviation = Math.max(...path.map((p) => deviationFromLine(from, to, p)));
  assert.ok(maxDeviation > 2, `path should bow off-line, max deviation was ${maxDeviation}`);
});

test('a zero-length move stays at the point (no NaN from the divide-by-zero guard)', () => {
  const path = mousePath({ x: 42, y: 42 }, { x: 42, y: 42 }, { seed: 'z' });
  for (const p of path) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    assert.equal(p.x, 42);
    assert.equal(p.y, 42);
  }
});

test('moveTimings returns one positive delay per hop, summing to ~totalMs, slower at the ends', () => {
  const hops = 20;
  const timings = moveTimings(hops, { seed: 'mt', totalMs: 500 });
  assert.equal(timings.length, hops);
  assert.ok(timings.every((d) => d > 0));
  const sum = timings.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 500) < 1, `sum ${sum} should be ~500`);
  // Ease-in-out: the first+last gaps are larger than a middle gap.
  const mid = timings[Math.floor(hops / 2)] as number;
  assert.ok((timings[0] as number) > mid && (timings[hops - 1] as number) > mid);
});

test('typingCadence has one positive delay per char, deterministic, with a pause after punctuation', () => {
  const text = 'Hi there. Go';
  const delays = typingCadence(text, { seed: 'tc', baseMs: 100 });
  assert.equal(delays.length, [...text].length);
  assert.ok(delays.every((d) => d > 0));
  assert.deepEqual(delays, typingCadence(text, { seed: 'tc', baseMs: 100 }));
  // The char right after the '.' (index of the space after "there.") carries an added pause.
  const dotIdx = text.indexOf('.');
  assert.ok(
    (delays[dotIdx + 1] as number) > 100,
    'the keystroke following sentence punctuation should pause longer',
  );
});

test('humanMouseMove emits integer, hover (buttons:0) moves per hop, skipping the start pixel', async () => {
  const cdp = new RecordingCdp();
  const from = { x: 0, y: 0 };
  const to = { x: 320, y: 180 };
  const end = await humanMouseMove(cdp, from, to, { seed: 'hm', sleep: noSleep });
  const moves = cdp.ofType('mouseMoved');
  assert.ok(moves.length >= 12);
  assert.deepEqual(end, to);
  // The current position is not re-emitted; moves are hover moves with no button held.
  assert.ok(
    !(moves[0]?.x === from.x && moves[0]?.y === from.y),
    'first move must not be the start pixel',
  );
  assert.equal(moves[0]?.button, 'none');
  assert.equal(moves[0]?.buttons, 0);
  assert.equal(moves[moves.length - 1]?.x, to.x);
  assert.equal(moves[moves.length - 1]?.y, to.y);
  // Integer device pixels only — arbitrary sub-pixel coords are themselves a synthetic tell.
  for (const m of moves) {
    assert.ok(Number.isInteger(m.x) && Number.isInteger(m.y), `sub-pixel coord ${m.x},${m.y}`);
  }
});

test('humanClick presses (buttons:1) then releases (buttons:0) the left button at the target', async () => {
  const cdp = new RecordingCdp();
  const to = { x: 200, y: 90 };
  await humanClick(cdp, { x: 0, y: 0 }, to, { seed: 'hc', sleep: noSleep });
  const press = cdp.ofType('mousePressed');
  const release = cdp.ofType('mouseReleased');
  assert.equal(press.length, 1);
  assert.equal(release.length, 1);
  assert.equal(press[0]?.button, 'left');
  assert.equal(press[0]?.buttons, 1); // held during the press — impossible-state guard
  assert.equal(release[0]?.buttons, 0);
  assert.equal(release[0]?.x, to.x);
  const types = cdp.calls.map((c) => c.params?.type);
  assert.ok(types.lastIndexOf('mouseMoved') < types.indexOf('mousePressed'));
  assert.ok(types.indexOf('mousePressed') < types.indexOf('mouseReleased'));
});

test('humanClick supports a protocol-correct right double-click', async () => {
  const cdp = new RecordingCdp();
  await humanClick(
    cdp,
    { x: 0, y: 0 },
    { x: 30, y: 40 },
    {
      button: 'right',
      count: 2,
      seed: 'right-double',
      sleep: noSleep,
    },
  );
  const presses = cdp.ofType('mousePressed');
  assert.equal(presses.length, 2);
  assert.deepEqual(
    presses.map((item) => item.clickCount),
    [1, 2],
  );
  assert.ok(presses.every((item) => item.button === 'right' && item.buttons === 2));
});

test('humanDrag holds the left button across the movement', async () => {
  const cdp = new RecordingCdp();
  await humanDrag(
    cdp,
    { x: 0, y: 0 },
    { x: 20, y: 20 },
    { x: 220, y: 100 },
    {
      seed: 'drag',
      sleep: noSleep,
    },
  );
  const pressed = cdp.ofType('mousePressed');
  const dragged = cdp.ofType('mouseMoved').filter((item) => item.buttons === 1);
  const released = cdp.ofType('mouseReleased');
  assert.equal(pressed.length, 1);
  assert.ok(dragged.length >= 12);
  assert.ok(dragged.every((item) => item.button === 'left' && item.buttons === 1));
  assert.equal(released.at(-1)?.buttons, 0);
});

test('humanType inserts each char once (keyDown+keyUp, NO char event) with key/code populated', async () => {
  const cdp = new RecordingCdp();
  await humanType(cdp, 'aB2', { seed: 'ht', sleep: noSleep });
  // 'a' and '2' emit one keyDown/keyUp each; the uppercase 'B' also brackets a Shift keyDown/keyUp.
  assert.equal(cdp.ofType('keyDown').length, 4);
  assert.equal(cdp.ofType('keyUp').length, 4);
  // Exactly one text-bearing keyDown per input char — the Shift press carries no text (no double-insert).
  assert.equal(cdp.ofType('keyDown').filter((p) => p.text !== undefined).length, 3);
  assert.equal(
    cdp.ofType('char').length,
    0,
    'a separate char event would double-insert the character',
  );
  // First two events are keyDown then keyUp for 'a', with key/code/keyCode set (listeners read these).
  const down = cdp.calls[0]?.params;
  assert.equal(down?.type, 'keyDown');
  assert.equal(down?.key, 'a');
  assert.equal(down?.code, 'KeyA');
  assert.equal(down?.text, 'a');
  assert.equal(down?.windowsVirtualKeyCode, 65);
  assert.equal(cdp.calls[1]?.params?.type, 'keyUp');
  // A digit resolves to a Digit* code.
  const digitDown = cdp.calls.find((c) => c.params?.text === '2');
  assert.equal(digitDown?.params?.code, 'Digit2');
});

test('humanType brackets a shifted char with a real Shift press and tags the Shift modifier', async () => {
  const cdp = new RecordingCdp();
  await humanType(cdp, 'A', { seed: 'sh', sleep: noSleep });
  // Real hardware order: Shift down, char down, char up, Shift up.
  const types = cdp.calls.map((c) => ({ type: c.params?.type, key: c.params?.key }));
  assert.deepEqual(types, [
    { type: 'keyDown', key: 'Shift' },
    { type: 'keyDown', key: 'A' },
    { type: 'keyUp', key: 'A' },
    { type: 'keyUp', key: 'Shift' },
  ]);
  const shiftDown = cdp.calls[0]?.params;
  assert.equal(shiftDown?.code, 'ShiftLeft');
  assert.equal(shiftDown?.windowsVirtualKeyCode, 16);
  assert.equal(shiftDown?.modifiers, 8);
  // The letter carries an authoritative code/keyCode and the Shift modifier (e.shiftKey === true).
  const letterDown = cdp.calls[1]?.params;
  assert.equal(letterDown?.code, 'KeyA');
  assert.equal(letterDown?.windowsVirtualKeyCode, 65);
  assert.equal(letterDown?.text, 'A');
  assert.equal(letterDown?.modifiers, 8);
  assert.equal(cdp.calls[2]?.params?.modifiers, 8); // the keyUp too
});

test('humanType gives shifted symbols a real US-layout code/keyCode + Shift (never code:"" keyCode:0)', async () => {
  const cdp = new RecordingCdp();
  await humanType(cdp, '!', { seed: 'ex', sleep: noSleep });
  const types = cdp.calls.map((c) => c.params?.type);
  assert.deepEqual(types, ['keyDown', 'keyDown', 'keyUp', 'keyUp']); // Shift brackets the symbol
  const bang = cdp.calls[1]?.params;
  assert.equal(bang?.key, '!');
  assert.equal(bang?.code, 'Digit1'); // Shift+1 on a US layout — was '' before the fix
  assert.equal(bang?.windowsVirtualKeyCode, 49); // was 0 before the fix
  assert.equal(bang?.text, '!');
  assert.equal(bang?.modifiers, 8);
  assert.equal(cdp.calls[0]?.params?.key, 'Shift');
});

test('humanType leaves an unshifted symbol unshifted but with a real code/keyCode', async () => {
  const cdp = new RecordingCdp();
  await humanType(cdp, '.', { seed: 'dot', sleep: noSleep });
  // No Shift key events for an unshifted symbol — just the char keyDown/keyUp.
  assert.equal(cdp.calls.filter((c) => c.params?.key === 'Shift').length, 0);
  const dot = cdp.calls.find((c) => c.params?.type === 'keyDown')?.params;
  assert.equal(dot?.code, 'Period'); // was '' before the fix
  assert.equal(dot?.windowsVirtualKeyCode, 190); // was 0 before the fix
  assert.equal(dot?.modifiers, 0);
});

test('humanType commits non-US text through the IME path instead of impossible key metadata', async () => {
  const cdp = new RecordingCdp();
  await humanType(cdp, 'é🙂', { seed: 'ime', sleep: noSleep });
  assert.deepEqual(
    cdp.calls.map((call) => [call.method, call.params?.text]),
    [
      ['Input.insertText', 'é'],
      ['Input.insertText', '🙂'],
    ],
  );
});
