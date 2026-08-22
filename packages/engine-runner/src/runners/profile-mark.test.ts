import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { profileMark } from './profile-mark.js';

/** The manager's copy of the rule, relative to this test's compiled location under dist/runners/. */
const DESKTOP_COPY = fileURLToPath(
  new URL('../../../../apps/desktop/src/ui/profile-mark.ts', import.meta.url),
);
const SIDECAR_COPY = fileURLToPath(new URL('../../src/runners/profile-mark.ts', import.meta.url));

test('the manager UI carries the same mark rule, byte for byte', () => {
  // The manager is a browser bundle and cannot import the sidecar, so the rule is duplicated. What
  // makes that safe is this: a profile whose window shows "AU" must never sit in a list showing
  // "AC", and the only way two copies of a Unicode reduction stay equal is if they are equal.
  assert.equal(
    readFileSync(DESKTOP_COPY, 'utf8'),
    readFileSync(SIDECAR_COPY, 'utf8'),
    'apps/desktop/src/ui/profile-mark.ts has drifted from ' +
      'packages/engine-runner/src/runners/profile-mark.ts - copy one over the other',
  );
});

test('two words give two initials, one word gives one', () => {
  assert.equal(profileMark('Acme US', 'p1').initials, 'AU');
  assert.equal(profileMark('alice', 'p1').initials, 'A');
  // Separators people type inside a name are word boundaries, not letters.
  assert.equal(profileMark('acme-us', 'p1').initials, 'AU');
  assert.equal(profileMark('qa_02_retail', 'p1').initials, 'Q0');
  // Only the first two words are read; the rest never reach the icon.
  assert.equal(profileMark('one two three four', 'p1').initials, 'OT');
});

test('non-Latin names reduce to their own script rather than to nothing', () => {
  assert.equal(profileMark('Профиль 1', 'p1').initials, 'П1');
  assert.equal(profileMark('日本 太郎', 'p1').initials, '日太');
  // An uppercase mapping that lengthens must not spend a second glyph slot.
  assert.equal(profileMark('ßeta gamma', 'p1').initials, 'SG');
});

test('emoji and punctuation are skipped while a word with letters remains', () => {
  assert.equal(profileMark('\u{1F680} Rocket', 'p1').initials, 'R');
  // A combining sequence stays whole instead of losing its mark.
  assert.equal(profileMark('ñandu', 'p1').initials, 'Ñ');
  // A name made only of symbols still gets a mark - its first glyph.
  assert.equal(profileMark('\u{1F680}\u{1F680}', 'p1').initials, '\u{1F680}');
});

test('a nameless profile has no mark, so the engine keeps the stock icon', () => {
  assert.equal(profileMark('', 'p1').initials, '');
  assert.equal(profileMark('   ', 'p1').initials, '');
  assert.equal(profileMark('', 'p1').word, '');
});

test('the label is the whole NAME, cut to what a wrapped icon can hold', () => {
  // The first word alone could not tell "Acme US East" from "Acme US West" - both marked "Acme".
  assert.equal(profileMark('Acme US', 'p1').word, 'Acme US');
  assert.equal(profileMark('Acme US East', 'p1').word, 'Acme US East');
  // Separators normalise to spaces, which is where the renderer is allowed to break the line.
  assert.equal(profileMark('acme-us-east', 'p1').word, 'acme us east');
  // Cut at the grapheme budget so a pathological name cannot shrink the type to noise.
  assert.equal(profileMark('extraordinarily-long-profile-name-here', 'p1').word.length <= 24, true);
  // Cut by grapheme, so the cut can never split an emoji sequence in half.
  assert.equal(profileMark('\u{1F468}‍\u{1F680}x', 'p1').word, '\u{1F468}‍\u{1F680}x');
});

test('the tint is a brand violet, stable per profile ID and independent of the name', () => {
  const ramp = new Set(['#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95']);
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', '0e6d3d2a-1f4b-4c9a-9f3e-2b7c8d1a5e60']) {
    assert.ok(ramp.has(profileMark('Any Name', id).tint), `${id} left the brand ramp`);
  }
  // Renaming must not recolour a profile the operator already recognises.
  assert.equal(profileMark('Acme US', 'p1').tint, profileMark('Different Name', 'p1').tint);
  // And the ramp is actually spread over, not collapsed onto one stop.
  const seen = new Set(Array.from({ length: 64 }, (_, i) => profileMark('n', `profile-${i}`).tint));
  assert.equal(seen.size, 4);
});
