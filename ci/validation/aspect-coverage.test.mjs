import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ASPECTS,
  ASPECT_IDS,
  aspectOf,
  exitCodeFor,
  scoreAspects,
} from './aspect-coverage.mjs';
import { ORACLES } from './audit-oracles.mjs';

const ONE = [{ id: 'only', title: 'only' }];
const row = (over) => ({ id: 'x', aspect: 'only', status: 'fixed', pass: true, ...over });

test('an aspect nobody probes fails rather than scoring zero quietly', () => {
  const score = scoreAspects([], { aspects: ONE });
  assert.equal(score.aspects.only.verdict, 'fail');
  assert.equal(score.aspects.only.total, 0);
  assert.equal(exitCodeFor(score), 1);
});

test('an inconclusive closed oracle blocks and never counts as a pass', () => {
  const score = scoreAspects([row({ pass: false, inconclusive: true })], { aspects: ONE });
  assert.equal(score.aspects.only.verdict, 'blocked');
  assert.equal(score.aspects.only.passed, 0);
  assert.equal(exitCodeFor(score), 2);
});

test('an aspect with only open oracles that measured nothing is blocked, not green', () => {
  const score = scoreAspects([row({ status: 'open', pass: false, inconclusive: true })], {
    aspects: ONE,
  });
  assert.equal(score.aspects.only.verdict, 'blocked');
  assert.equal(exitCodeFor(score), 2);
});

test('a measured regression outranks a block in the same aspect', () => {
  const score = scoreAspects(
    [row({ id: 'a', pass: false }), row({ id: 'b', pass: false, inconclusive: true })],
    { aspects: ONE },
  );
  assert.equal(score.aspects.only.verdict, 'fail');
  assert.match(score.aspects.only.reason, /a/);
  assert.equal(exitCodeFor(score), 1);
});

test('a known-open oracle that fails does not redden its aspect', () => {
  const score = scoreAspects([row({ id: 'a' }), row({ id: 'b', status: 'open', pass: false })], {
    aspects: ONE,
  });
  assert.equal(score.aspects.only.verdict, 'pass');
  assert.equal(score.aspects.only.failed, 1);
});

test('rows the environment does not apply to are excluded, not scored as passes', () => {
  const score = scoreAspects([row({ applicable: false })], { aspects: ONE });
  assert.equal(score.aspects.only.total, 0);
  assert.equal(score.aspects.only.inapplicable, 1);
  // A gap in the environment blocks; only a gap in the work fails.
  assert.equal(score.aspects.only.verdict, 'blocked');
  assert.equal(exitCodeFor(score), 2);
});

test('the coverage index counts aspects, not oracles', () => {
  const aspects = [
    { id: 'a', title: 'a' },
    { id: 'b', title: 'b' },
  ];
  const score = scoreAspects(
    [
      { id: '1', aspect: 'a', status: 'fixed', pass: true },
      { id: '2', aspect: 'a', status: 'fixed', pass: true },
      { id: '3', aspect: 'a', status: 'fixed', pass: true },
      { id: '4', aspect: 'b', status: 'fixed', pass: false },
    ],
    { aspects },
  );
  assert.equal(score.coverageIndex, 0.5);
  assert.equal(score.oracleIndex, 0.75);
  assert.deepEqual(score.failedAspects, ['b']);
});

test('every declared aspect has at least one oracle', () => {
  // The offline half of the release bar: it needs no browser, so a newly declared aspect cannot sit
  // uncovered until someone happens to run the gate on the GPU box.
  const covered = new Set(ORACLES.map((o) => aspectOf(o)));
  const missing = ASPECT_IDS.filter((id) => !covered.has(id));
  // TLS and HTTP/2 are measured by tls-fingerprint.mjs against a live echo, not by an in-page oracle;
  // audit-oracles folds that report in, and records the aspects as blocked when it is absent.
  const measuredElsewhere = new Set(['networkTls', 'networkHttp2']);
  assert.deepEqual(
    missing.filter((id) => !measuredElsewhere.has(id)),
    [],
  );
});

test('no oracle lands outside the declared aspects', () => {
  const declared = new Set(ASPECT_IDS);
  const strays = ORACLES.filter((o) => !declared.has(aspectOf(o))).map((o) => o.id);
  assert.deepEqual(strays, []);
});

test('aspect ids are unique', () => {
  assert.equal(new Set(ASPECT_IDS).size, ASPECTS.length);
});
