import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertExactScannedFamilies,
  buildLicenseLedger,
  declaredSourceFamilies,
  fontPackContentIdentity,
} from '../../scripts/provision-open-fonts.mjs';

const metadata = JSON.parse(
  await readFile(new URL('../../lobium/fonts/sources.json', import.meta.url), 'utf8'),
);

const source = (family) => metadata.families.find((entry) => entry.family === family);

test('CJK TTC metadata declares every approved companion family', () => {
  assert.deepEqual(declaredSourceFamilies(source('Noto Sans CJK JP')), [
    'Noto Sans CJK HK',
    'Noto Sans CJK JP',
    'Noto Sans CJK KR',
    'Noto Sans CJK SC',
    'Noto Sans CJK TC',
    'Noto Sans Mono CJK HK',
    'Noto Sans Mono CJK JP',
    'Noto Sans Mono CJK KR',
    'Noto Sans Mono CJK SC',
    'Noto Sans Mono CJK TC',
  ]);
  assert.deepEqual(declaredSourceFamilies(source('Noto Serif CJK JP')), [
    'Noto Serif CJK HK',
    'Noto Serif CJK JP',
    'Noto Serif CJK KR',
    'Noto Serif CJK SC',
    'Noto Serif CJK TC',
  ]);
});

test('font scan inventory is exact and fails on missing or arbitrary families', () => {
  const notoSans = source('Noto Sans CJK JP');
  const declared = declaredSourceFamilies(notoSans);
  assert.deepEqual(
    assertExactScannedFamilies('NotoSansCJK-Regular.ttc', notoSans, declared),
    declared,
  );
  assert.throws(
    () => assertExactScannedFamilies('NotoSansCJK-Regular.ttc', notoSans, declared.slice(1)),
    /missing: Noto Sans CJK HK; undeclared: none/,
  );
  assert.throws(
    () =>
      assertExactScannedFamilies('NotoSansCJK-Regular.ttc', notoSans, [
        ...declared,
        'Unreviewed Host Sans',
      ]),
    /missing: none; undeclared: Unreviewed Host Sans/,
  );
});

test('license ledger covers companion families under the same reviewed source license', () => {
  const families = declaredSourceFamilies(source('Noto Sans CJK JP'));
  const licenses = buildLicenseLedger(metadata, families);
  assert.equal(licenses.length, families.length);
  assert.deepEqual(
    licenses.map(({ family }) => family),
    families,
  );
  assert.ok(licenses.every(({ license }) => license === 'OFL-1.1'));
  assert.ok(licenses.every(({ licenseUrl }) => licenseUrl.includes('/notofonts/noto-cjk/')));
});

test('pack identity is stable under family ordering and changes with companion inventory', () => {
  const base = [{ sha256: 'a'.repeat(64), families: ['Noto Sans CJK JP'] }];
  const expanded = [
    {
      sha256: 'a'.repeat(64),
      families: ['Noto Sans CJK JP', 'Noto Sans CJK HK'],
    },
  ];
  assert.notEqual(fontPackContentIdentity(base), fontPackContentIdentity(expanded));
  assert.equal(
    fontPackContentIdentity(expanded),
    fontPackContentIdentity([
      {
        sha256: 'a'.repeat(64),
        families: ['Noto Sans CJK HK', 'Noto Sans CJK JP'],
      },
    ]),
  );
});
