import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChromeBrands, ENGINE_CHROME } from './pools.js';
import { deriveFingerprint } from './derive.js';

/**
 * Sec-CH-UA brand-list conformance.
 *
 * Chromium generates this list deterministically from the UA major version — including the "GREASE"
 * decoy brand's spelling and the order of all three entries. It is NOT free-form. A hardcoded list is
 * therefore correct for exactly one Chrome release and wrong for every other one, and because
 * Sec-CH-UA is a low-entropy client hint it rides EVERY HTTP request (worker fetches included). Any
 * edge keeping a Chrome-major -> expected-brand-string table catches a stale token instantly.
 *
 * The expectations below are computed from Chromium's algorithm in
 * components/embedder_support/user_agent_utils.cc:
 *   greasey_chars   = {" ","(",":","-",".","/",")",";","=","?","_"}
 *   greasey_brand   = "Not" + chars[seed%11] + "A" + chars[(seed+1)%11] + "Brand"
 *   greasey_version = {"8","99","24"}[seed%3]
 *   orders          = {{0,1,2},{0,2,1},{1,0,2},{1,2,0},{2,0,1},{2,1,0}}[seed%6]
 *   shuffled[order[i]] = list[i]   where list = [GREASE, Chromium, Google Chrome]
 */

const render = (list: Array<{ brand: string; version: string }>): string =>
  list.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');

test('matches Chrome 152 exactly (the pinned engine build)', () => {
  // 152%11=9 -> "?" ; 153%11=10 -> "_" ; 152%3=2 -> "24" ; 152%6=2 -> orders[2]={1,0,2}
  assert.equal(
    render(buildChromeBrands('152')),
    '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
  );
});

test('reproduces known-shipped brand strings from earlier Chrome releases', () => {
  // Independent cross-checks: these are the strings those releases actually sent, so agreeing with
  // them proves the algorithm, not just self-consistency with our own implementation.
  const expected: Record<string, string> = {
    // 120%11=10 -> "_" ; 121%11=0 -> " " ; 120%3=0 -> "8" ; 120%6=0 -> {0,1,2}
    '120': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    // 124%11=3 -> "-" ; 125%11=4 -> "." ; 124%3=1 -> "99" ; 124%6=4 -> {2,0,1}
    '124': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    // 131%11=10 -> "_" ; 132%11=0 -> " " ; 131%3=2 -> "24" ; 131%6=5 -> {2,1,0}
    '131': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  };
  for (const [major, want] of Object.entries(expected)) {
    assert.equal(render(buildChromeBrands(major)), want, `Chrome ${major}`);
  }
});

test('always emits exactly one GREASE decoy plus both real brands', () => {
  // Sweep a wide major range: every release must produce a well-formed list, never a duplicate or a
  // missing real brand, whichever permutation the seed selects.
  for (let major = 100; major <= 200; major += 1) {
    const list = buildChromeBrands(String(major));
    assert.equal(list.length, 3, `major ${major}`);
    const brands = list.map((b) => b.brand);
    assert.ok(brands.includes('Chromium'), `major ${major} missing Chromium`);
    assert.ok(brands.includes('Google Chrome'), `major ${major} missing Google Chrome`);
    const grease = list.filter((b) => /^Not.A.Brand$/.test(b.brand));
    assert.equal(grease.length, 1, `major ${major} GREASE count`);
    assert.ok(
      ['8', '99', '24'].includes(grease[0]!.version),
      `major ${major} GREASE version ${grease[0]!.version}`,
    );
    // The two real brands always carry the UA major; only the decoy differs.
    for (const b of list.filter((x) => x.brand !== grease[0]!.brand)) {
      assert.equal(b.version, String(major), `major ${major} real brand version`);
    }
    assert.equal(new Set(brands).size, 3, `major ${major} duplicate brand`);
  }
});

test('the derived persona carries the algorithmic list, not a hardcoded one', () => {
  // Guards the wiring: pools.ts could be correct while derive.ts still used a literal.
  const fp = deriveFingerprint('brand-wiring-seed', { os: 'windows', engine: 'lobium' });
  assert.equal(render(fp.navigator.uaBrands), render(buildChromeBrands(ENGINE_CHROME.major)));
  assert.ok(
    fp.navigator.uaBrands.some((b) => b.brand === `Not?A_Brand`),
    'Chrome 152 persona must carry the Not?A_Brand decoy',
  );
});

test('rejects a non-numeric major rather than emitting an impossible list', () => {
  for (const bad of ['', 'abc', '-1', '15.2']) {
    assert.throws(() => buildChromeBrands(bad), /invalid Chrome major/, `input ${JSON.stringify(bad)}`);
  }
});
