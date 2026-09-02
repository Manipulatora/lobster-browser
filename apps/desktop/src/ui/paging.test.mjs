import assert from 'node:assert/strict';
import test from 'node:test';

// apps/desktop has no bundler-side test harness (its `build` is tsc --noEmit + vite), so these are
// plain node:test files over the pure .ts module — Node's type stripping runs it directly:
//   node --test apps/desktop/src/ui/*.test.mjs
import { PAGE_SIZE, clampPage, pageCountFor, pageSlice, pagerItems } from './paging.ts';

test('pageCountFor: an empty list still stands on page 1', () => {
  assert.equal(pageCountFor(0), 1);
  assert.equal(pageCountFor(-5), 1);
  assert.equal(pageCountFor(Number.NaN), 1);
});

test('pageCountFor: boundaries land on whole pages', () => {
  assert.equal(pageCountFor(1), 1);
  assert.equal(pageCountFor(PAGE_SIZE), 1);
  assert.equal(pageCountFor(PAGE_SIZE + 1), 2);
  assert.equal(pageCountFor(PAGE_SIZE * 4), 4);
  assert.equal(pageCountFor(10, 3), 4);
});

test('clampPage: pins to [1, pageCount] so a shrunken list cannot strand the view', () => {
  // The delete-the-last-row-of-the-last-page case: the stale page number degrades to the new last.
  assert.equal(clampPage(9, 3), 3);
  assert.equal(clampPage(0, 3), 1);
  assert.equal(clampPage(-2, 3), 1);
  assert.equal(clampPage(2, 3), 2);
});

test('clampPage: garbage in, a real page out', () => {
  assert.equal(clampPage(Number.NaN, 5), 1);
  assert.equal(clampPage(2.7, 5), 2);
  assert.equal(clampPage(3, Number.NaN), 1);
  assert.equal(clampPage(3, 0), 1);
});

test('pageSlice: slices the requested page and clamps a stale one', () => {
  const items = Array.from({ length: 7 }, (_, i) => i + 1);
  assert.deepEqual(pageSlice(items, 1, 3), [1, 2, 3]);
  assert.deepEqual(pageSlice(items, 3, 3), [7]);
  // Page 9 of 3 is the last page, not an empty one.
  assert.deepEqual(pageSlice(items, 9, 3), [7]);
  assert.deepEqual(pageSlice([], 1, 3), []);
});

test('pagerItems: one page means one item — the component hides the whole strip then', () => {
  assert.deepEqual(pagerItems(1, 1), [1]);
});

test('pagerItems: small counts list every page with no gap', () => {
  assert.deepEqual(pagerItems(2, 4), [1, 2, 3, 4]);
  assert.deepEqual(pagerItems(1, 3), [1, 2, 3]);
});

test('pagerItems: far ends elide the middle', () => {
  assert.deepEqual(pagerItems(1, 10), [1, 2, 'gap', 10]);
  assert.deepEqual(pagerItems(10, 10), [1, 'gap', 9, 10]);
});

test('pagerItems: a middle page keeps its neighbours and both ends', () => {
  assert.deepEqual(pagerItems(5, 10), [1, 'gap', 4, 5, 6, 'gap', 10]);
});

test('pagerItems: a gap never hides a single page — the page itself is shorter', () => {
  // 1 [2] 3 4 … would elide nothing between 1 and 1; between 4 and 6 sits exactly page 5.
  assert.deepEqual(pagerItems(3, 6), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(pagerItems(4, 6), [1, 2, 3, 4, 5, 6]);
});

test('pagerItems: an out-of-range page is clamped before the strip is built', () => {
  assert.deepEqual(pagerItems(99, 10), [1, 'gap', 9, 10]);
  assert.deepEqual(pagerItems(0, 10), [1, 2, 'gap', 10]);
});
