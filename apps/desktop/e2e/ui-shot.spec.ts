import { test } from '@playwright/test';

/** Exploratory: capture what the fingerprint step actually renders, and inventory its controls. */
test('capture the fingerprint step', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: /create profile/i })
    .first()
    .click();
  await page.getByText('Fingerprint', { exact: true }).first().click();
  await page.waitForTimeout(800);

  const inventory = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return { error: 'no dialog' };
    const selects = [...dialog.querySelectorAll('select')].map((el) => ({
      label:
        el.getAttribute('aria-label') ??
        el.closest('label')?.querySelector('.lb-field__label')?.textContent?.trim() ??
        '(unlabelled)',
      options: el.options.length,
    }));
    const custom = [...dialog.querySelectorAll('[aria-haspopup="listbox"]')].map((el) => ({
      cls: el.className,
      text: (el.textContent ?? '').trim().slice(0, 40),
    }));
    return { nativeSelects: selects, customDropdowns: custom };
  });
  console.log('CONTROL INVENTORY: ' + JSON.stringify(inventory, null, 2));

  await page.locator('.lb-modal').first().screenshot({ path: 'test-results/fingerprint-step.png' });

  // And the font panel open, so its layout is visible.
  const trigger = page.locator('.font-multiselect__summary');
  if (await trigger.isVisible().catch(() => false)) {
    await trigger.click();
    await page.waitForTimeout(500);
    await page.locator('.lb-modal').first().screenshot({ path: 'test-results/font-panel.png' });
  }
});
