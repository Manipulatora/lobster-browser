import { expect, test } from '@playwright/test';

const baseUrl = process.env.LOBSTER_E2E_URL ?? 'http://127.0.0.1:5181/';

test('a stored proxy can be re-pointed, and renaming one keeps what its last check found', async ({
  page,
}) => {
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Proxies' }).click();

  const row = page.getByRole('row').filter({ hasText: 'US Residential Gateway' });
  await expect(row).toContainText('us-east.proxy.local:9443');
  await expect(row).toContainText('Ready');
  await expect(row).toContainText('84 ms');

  // A RENAME IS NOT A CHECK. The row was green with a latency and a location before this, and a new
  // label is not evidence about the endpoint either way.
  await page.getByLabel('More actions for US Residential Gateway').click();
  await page.getByRole('menuitem', { name: 'Edit proxy' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit proxy' });
  await expect(dialog.getByLabel('Host')).toHaveValue('us-east.proxy.local');
  await expect(dialog.getByLabel('Port')).toHaveValue('9443');
  await dialog.getByLabel('Title').fill('US Residential Primary');
  await dialog.getByRole('button', { name: 'Save proxy' }).click();
  // The confirmation toast is gone product-wide (the corner notification region was removed);
  // what follows asserts the actual outcome, which is the stronger check anyway.

  const renamed = page.getByRole('row').filter({ hasText: 'US Residential Primary' });
  await expect(renamed).toContainText('Ready');
  await expect(renamed).toContainText('84 ms');
  await expect(renamed).toContainText('US · New York · New York');

  // Moving the endpoint is the opposite case: the recorded latency and location describe a proxy
  // that is no longer there, so they go with it.
  await page.getByLabel('More actions for US Residential Primary').click();
  await page.getByRole('menuitem', { name: 'Edit proxy' }).click();
  await dialog.getByRole('combobox', { name: 'Protocol' }).selectOption('socks5');
  await dialog.getByLabel('Host').fill('eu-west.proxy.local');
  await dialog.getByLabel('Port').fill('8443');
  await dialog.getByLabel('Login').fill('rotating-user');
  await dialog.getByLabel('Password').fill('rotating-pass');
  await dialog.getByLabel('URL for IP Change').fill('https://provider.example/rotate?token=abc');
  await dialog.getByRole('button', { name: 'Save proxy' }).click();
  // The confirmation toast is gone product-wide (the corner notification region was removed);
  // what follows asserts the actual outcome, which is the stronger check anyway.

  await expect(renamed).toContainText('eu-west.proxy.local:8443');
  await expect(renamed).toContainText('SOCKS5');
  await expect(renamed).toContainText('Not tested');

  // The credentials and the rotation URL came back with the row, not just the host and port.
  await page.getByLabel('More actions for US Residential Primary').click();
  await page.getByRole('menuitem', { name: 'Edit proxy' }).click();
  await expect(dialog.getByLabel('Login')).toHaveValue('rotating-user');
  await expect(dialog.getByLabel('Password')).toHaveValue('rotating-pass');
  await expect(dialog.getByLabel('URL for IP Change')).toHaveValue(
    'https://provider.example/rotate?token=abc',
  );
  await page.keyboard.press('Escape');
  await page.getByLabel('More actions for US Residential Primary').click();
  await expect(page.getByRole('menuitem', { name: 'Rotate IP' })).toBeVisible();
});

test('hive proxies are listed on the proxies screen and are not editable there', async ({
  page,
}) => {
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Proxies' }).click();

  // A hive proxy is bindable from the template and profile pickers, so a proxies screen that hides
  // it leaves the user unable to see what their profiles are running through.
  const hive = page.getByRole('row').filter({ hasText: 'Hive US Mobile Pool' });
  await expect(hive).toContainText('Managed endpoint');
  await expect(hive).toContainText('Hive');

  await page.getByLabel('More actions for Hive US Mobile Pool').click();
  await expect(page.getByRole('menuitem', { name: 'Edit proxy' })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Delete proxy' })).toBeEnabled();
});

test('a pasted proxy list imports the good lines and names the bad ones', async ({ page }) => {
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Proxies' }).click();
  await page.getByRole('button', { name: 'Import' }).click();

  const dialog = page.getByRole('dialog', { name: 'Import proxies' });
  await dialog
    .getByRole('textbox')
    .fill(
      ['# from the provider panel', '1.2.3.4:8080:bob:secret', 'not-a-proxy', '5.6.7.8:3128'].join(
        '\n',
      ),
    );
  await expect(dialog.getByRole('status')).toContainText('2 ready to import');
  await expect(dialog.getByRole('status')).toContainText('1 could not be read');
  await expect(dialog).toContainText('Line 3');

  await dialog.getByRole('button', { name: 'Import 2' }).click();
  // The confirmation toast is gone product-wide (the corner notification region was removed);
  // what follows asserts the actual outcome, which is the stronger check anyway.
  await expect(page.getByRole('row').filter({ hasText: '1.2.3.4:8080' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: '5.6.7.8:3128' })).toBeVisible();
});

test('the proxy dialog names its protocol control and shows focus on its paste button', async ({
  page,
}) => {
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Proxies' }).click();
  await page.getByRole('button', { name: 'Add Proxy' }).click();

  const dialog = page.getByRole('dialog', { name: 'Add proxy' });
  // The visible "Proxy *" text is a span shared by four controls, so it names none of them.
  await expect(dialog.getByRole('combobox', { name: 'Protocol' })).toBeVisible();

  const paste = dialog.getByRole('button', { name: 'Paste proxy URL' });
  await dialog.getByLabel('Port').focus();
  await page.keyboard.press('Tab');
  await expect(paste).toBeFocused();
  // The shared button ring is drawn outside the box, and this button sits flush against its
  // neighbour in a segmented row — where the ring used to be painted underneath it.
  await expect(paste).toHaveCSS('z-index', '1');
  expect(await paste.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
});

test('a template can be edited, duplicated and deleted', async ({ page }) => {
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Templates' }).click();
  await expect(page.getByText('US Retail Desktop', { exact: true })).toBeVisible();

  await page.getByLabel('More actions for US Retail Desktop', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit template' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit template' });
  await expect(dialog.getByLabel('Title')).toHaveValue('US Retail Desktop');
  await expect(dialog.getByLabel('Proxy')).toHaveValue('px-us-1');
  await dialog.getByLabel('Title').fill('EU Retail Desktop');
  await dialog.getByLabel('Timezone').selectOption('real');
  // The fields a template exists to carry are collected here, so the row can say what it presets.
  await dialog.getByLabel('Chrome Web Store extension').fill('abcdefghijklmnopabcdefghijklmnop');
  await dialog.getByRole('button', { name: 'Add extension' }).click();
  await dialog.getByRole('button', { name: 'Save template' }).click();

  const row = page.getByRole('row').filter({ hasText: 'EU Retail Desktop' });
  await expect(row).toContainText('Extensions (1)');
  await page.getByLabel('More actions for EU Retail Desktop', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit template' }).click();
  await expect(dialog.getByLabel('Timezone')).toHaveValue('real');
  await expect(dialog.getByText('abcdefghijklmnopabcdefghijklmnop')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.getByLabel('More actions for EU Retail Desktop', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  const copy = page.getByRole('row').filter({ hasText: 'EU Retail Desktop (copy)' });
  // A copy carries the whole template, not the fields whoever wrote the copy button remembered.
  await expect(copy).toContainText('Extensions (1)');
  await expect(copy).toContainText('US Residential Gateway');

  await page.getByLabel('More actions for EU Retail Desktop (copy)', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete template' }).click();
  await page
    .getByRole('dialog', { name: 'Delete template?' })
    .getByRole('button', { name: 'Delete template' })
    .click();
  // The confirmation toast is gone product-wide (the corner notification region was removed);
  // what follows asserts the actual outcome, which is the stronger check anyway.
  await expect(page.getByText('EU Retail Desktop (copy)', { exact: true })).toHaveCount(0);
  await expect(page.getByText('EU Retail Desktop', { exact: true })).toBeVisible();
});
