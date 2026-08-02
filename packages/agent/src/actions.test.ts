import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACT_TOOL, ACTION_CAPABILITIES, buildActionReference, parseAction } from './actions.js';

const KINDS = ACT_TOOL.inputSchema.properties.kind.enum;

test('every advertised action kind has a capability entry', () => {
  // The Record type makes this a compile error too; assert it at runtime as well so the schema and the
  // table cannot drift through a cast.
  for (const kind of KINDS) {
    assert.ok(
      ACTION_CAPABILITIES[kind],
      `action kind "${kind}" is offered to the model but has no capability entry`,
    );
  }
  assert.equal(Object.keys(ACTION_CAPABILITIES).length, KINDS.length);
});

test('capability defaults are pessimistic: mutating, and barred from privileged pages', () => {
  // A half-filled entry must produce an over-restricted action, never an under-guarded one — a kind
  // wrongly marked non-mutating silently disables the post-action navigation-drift check.
  const risky = KINDS.filter((kind) => {
    const c = ACTION_CAPABILITIES[kind]!;
    return !c.mutating && c.allowedOnPrivilegedPage;
  });
  assert.deepEqual(
    risky.sort(),
    ['done'],
    'only `done` may be both non-mutating and allowed on a privileged page',
  );
  // Everything that types, clicks, drags or navigates must be marked mutating.
  for (const kind of [
    'click',
    'click_at',
    'type',
    'type_at',
    'select',
    'key',
    'drag',
    'upload',
    'navigate',
    'back',
    'tab',
    'browser_config',
  ] as const) {
    assert.equal(ACTION_CAPABILITIES[kind]?.mutating, true, `${kind} must be mutating`);
  }
});

test('capability-gated kinds are advertised exactly when the run has the capability', () => {
  // The action reference is what the model reads. Advertising a kind the guard chain will refuse wastes
  // a step on `blocked: …`; gating one that is never advertised makes it dead. Both directions matter.
  const off = buildActionReference({ vision: false, uploads: false, uploadRoots: [] });
  const on = buildActionReference({ vision: true, uploads: true, uploadRoots: ['/tmp/uploads'] });

  for (const kind of KINDS) {
    const c = ACTION_CAPABILITIES[kind]!;
    if (c.requiresVision) {
      assert.ok(!off.includes(`${kind} {`), `${kind} must not be advertised without vision`);
      assert.ok(on.includes(kind), `${kind} must be advertised when vision is on`);
    }
    if (c.requiresUploadRoots) {
      assert.ok(!off.includes(`${kind} {`), `${kind} must not be advertised without upload roots`);
      assert.ok(on.includes(kind), `${kind} must be advertised when upload roots exist`);
    }
  }
});

test('an over-long summary or note is clamped rather than dropped', () => {
  const long = 'x'.repeat(9000);
  const done = parseAction({ kind: 'done', success: true, summary: long });
  assert.ok(done.ok && done.action.kind === 'done');
  assert.ok(done.action.summary.length > 0, 'the run result must never be silently emptied');
  assert.ok(done.action.summary.length <= 4000);

  const clicked = parseAction({ kind: 'click', id: 1, note: long });
  assert.ok(clicked.ok && clicked.action.kind === 'click');
  assert.ok((clicked.action.note ?? '').length <= 160);
});
