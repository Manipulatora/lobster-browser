import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Round-3 UI verification, driven against the real components.
 *
 * The desktop UI falls back to its in-memory mock client when `__TAURI_INTERNALS__` is absent
 * (apps/desktop/src/api/tauri.ts), so a plain Chromium exercises the actual React tree, reducers and
 * CSS. Dropdown open/close and layout are pure DOM behaviour, so what this observes is what the
 * packaged app does — and unlike reading the source, it can prove it.
 */

async function openFingerprintTab(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('button', { name: /create profile/i })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // The wizard is a tab strip, not a Next/Back flow.
  await page.getByText('Fingerprint', { exact: true }).first().click();
}

test('the font dropdown closes as soon as a font is picked', async ({ page }) => {
  await openFingerprintTab(page);

  const trigger = page.locator('.font-multiselect__summary');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const panel = page.locator('.font-multiselect__content');
  await expect(panel).toBeVisible();

  await page.locator('.font-chip').first().click();
  await expect(panel, 'picking a font must close the panel').toBeHidden({ timeout: 3000 });
});

test('the font list is one vertical column with a real scrollbar', async ({ page }) => {
  await openFingerprintTab(page);
  await page.locator('.font-multiselect__summary').click();
  await expect(page.locator('.font-multiselect__content')).toBeVisible();

  const list = page.locator('.font-multiselect__list');
  const overflow = await list.evaluate((el) => getComputedStyle(el).overflowY);
  expect(['auto', 'scroll']).toContain(overflow);
  const scrolls = await list.evaluate((el) => el.scrollHeight > el.clientHeight + 4);
  expect(scrolls, 'the list must overflow its box so the scrollbar is real').toBeTruthy();

  // One font per row: every chip shares the same left edge and each sits on its own line.
  const boxes = await page.locator('.font-chip').evaluateAll((els) =>
    els.slice(0, 8).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    }),
  );
  expect(boxes.length).toBeGreaterThan(2);
  expect(new Set(boxes.map((b) => b.x)).size, 'all chips share one x — a single column').toBe(1);
  expect(new Set(boxes.map((b) => b.y)).size, 'each chip on its own row').toBe(boxes.length);
});

test('the OS dropdown closes when an option is chosen', async ({ page }) => {
  await openFingerprintTab(page);
  const trigger = page.locator('.os-select__trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const list = page.locator('.os-select__list');
  await expect(list).toBeVisible();
  const before = (await trigger.textContent())?.trim();

  // Pick a DIFFERENT option than the current one so the change is observable.
  const options = list.getByRole('option');
  const n = await options.count();
  let picked = 0;
  for (let i = 0; i < n; i += 1) {
    const t = (await options.nth(i).textContent())?.trim();
    if (t && before && !before.includes(t)) {
      picked = i;
      break;
    }
  }
  await options.nth(picked).click();
  await expect(list, 'the OS dropdown must close after a pick').toBeHidden({ timeout: 3000 });
});

test('the modal never grows past the viewport', async ({ page }) => {
  await openFingerprintTab(page);
  const modal = page.locator('.lb-modal').first();
  const fits = await modal.evaluate(
    (el) => el.getBoundingClientRect().height <= window.innerHeight,
  );
  expect(fits, 'the modal must fit inside the viewport').toBeTruthy();
});

test('no bottom-right notification region exists any more', async ({ page }) => {
  await page.goto('/');
  expect(await page.locator('.lb-toast-region, .lb-toast').count()).toBe(0);
});
