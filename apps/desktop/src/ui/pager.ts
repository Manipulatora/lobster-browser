/**
 * Pagination math for the catalog tables (Profiles, Proxies, Templates), kept separate from the
 * {@link Pager} component so it is pure data-in/data-out — `pager.test.mjs` runs these functions
 * under `node --test` with no DOM and no React.
 */

/**
 * One page size for every paginated table, on purpose: a reader who learns "a page is 25 rows" on
 * Profiles should not have to relearn it on Proxies. 25 because the tables render ~48px rows, so a
 * full page is about two screenfuls on the common 1080p window — enough that paging is rare, small
 * enough that the poll-driven re-render of a page stays cheap and the scrollbar stays meaningful.
 */
export const PAGE_SIZE = 25;

/** Marks a run of pages elided from the numbered strip ("1 2 … 9"). */
export type PagerItem = number | 'gap';

/** How many pages `totalItems` occupies. Never 0: an empty list still has a page 1 to stand on. */
export function pageCountFor(totalItems: number, pageSize: number = PAGE_SIZE): number {
  if (!Number.isFinite(totalItems) || totalItems <= 0) return 1;
  return Math.max(1, Math.ceil(totalItems / pageSize));
}

/**
 * Pin a requested page inside [1, pageCount]. This is what keeps the view sane when the list
 * shrinks under it — delete the last row of the last page and the clamped page is the new last
 * page, not a blank one past the end. Garbage in (NaN, 0, 2.5) lands on a real page too.
 */
export function clampPage(page: number, pageCount: number): number {
  const bound = Math.max(1, Math.trunc(Number.isFinite(pageCount) ? pageCount : 1));
  const requested = Math.trunc(Number.isFinite(page) ? page : 1);
  return Math.min(Math.max(1, requested), bound);
}

/** The rows of one page. `page` is clamped, so a stale page number degrades to a real slice. */
export function pageSlice<T>(items: readonly T[], page: number, pageSize: number = PAGE_SIZE): T[] {
  const current = clampPage(page, pageCountFor(items.length, pageSize));
  return items.slice((current - 1) * pageSize, current * pageSize);
}

/**
 * The numbered strip: first page, last page, the current page and its immediate neighbours, with
 * `'gap'` standing in for every elided run. A gap never hides a SINGLE page — "1 … 3" would spend
 * an ellipsis to save nothing, so the lone page is shown instead. Worst case is seven items
 * (1 … 4 5 6 … 9), which is why the strip never needs to scroll or wrap.
 */
export function pagerItems(page: number, pageCount: number): PagerItem[] {
  const bound = Math.max(1, Math.trunc(Number.isFinite(pageCount) ? pageCount : 1));
  const current = clampPage(page, bound);
  const wanted = [...new Set([1, current - 1, current, current + 1, bound])]
    .filter((candidate) => candidate >= 1 && candidate <= bound)
    .sort((a, b) => a - b);

  const items: PagerItem[] = [];
  for (const [index, value] of wanted.entries()) {
    const previous = wanted[index - 1];
    if (previous !== undefined) {
      if (value - previous === 2) items.push(previous + 1);
      else if (value - previous > 2) items.push('gap');
    }
    items.push(value);
  }
  return items;
}
