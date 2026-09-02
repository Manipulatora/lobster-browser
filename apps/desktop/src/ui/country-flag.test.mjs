import assert from 'node:assert/strict';
import test from 'node:test';

// Plain node:test over the pure .ts module (Node's type stripping) — see pager.test.mjs for why:
//   node --test apps/desktop/src/ui/*.test.mjs
import { UNKNOWN_REGION_FLAG, countryCodeFrom, countryFlag, countryName } from './country-flag.ts';

test('an alpha-2 code becomes its regional-indicator pair, case-insensitively', () => {
  assert.equal(countryFlag('US'), '\u{1F1FA}\u{1F1F8}');
  assert.equal(countryFlag('us'), '\u{1F1FA}\u{1F1F8}');
  assert.equal(countryFlag('DE'), '\u{1F1E9}\u{1F1EA}');
});

test('a spelled-out country name maps through the name table', () => {
  assert.equal(countryFlag('United States'), '\u{1F1FA}\u{1F1F8}');
  assert.equal(countryFlag('united  kingdom'), '\u{1F1EC}\u{1F1E7}');
  assert.equal(countryFlag('Holland'), '\u{1F1F3}\u{1F1F1}');
});

test('a stored proxy location string is read by its leading segment', () => {
  // The shape ProxiesView writes: "CC · region · city".
  assert.equal(countryCodeFrom('US · New York · New York'), 'US');
  assert.equal(countryCodeFrom('DE · Hesse · Frankfurt'), 'DE');
  // A location that spells the country out still resolves.
  assert.equal(countryCodeFrom('United States, New York'), 'US');
  assert.equal(countryFlag('US · rotating'), '\u{1F1FA}\u{1F1F8}');
});

test('unknown regions fall back to the neutral globe, never a wrong flag', () => {
  assert.equal(countryFlag(undefined), UNKNOWN_REGION_FLAG);
  assert.equal(countryFlag(''), UNKNOWN_REGION_FLAG);
  assert.equal(countryFlag('Atlantis'), UNKNOWN_REGION_FLAG);
  assert.equal(countryFlag('Not tested'), UNKNOWN_REGION_FLAG);
  assert.equal(countryCodeFrom('USA1'), undefined);
});

test('countryName resolves codes and mapped names to a display name', () => {
  // Exact wording comes from ICU, so assert the stable part: it answers, and not with the raw code.
  assert.match(countryName('US'), /United States/);
  assert.match(countryName('united states'), /United States/);
  // Structurally invalid input degrades to the uppercased input rather than throwing.
  assert.equal(countryName('zz9'), 'ZZ9');
});
