import { expect, test, type Locator } from '@playwright/test';

import type { ProfileOsTarget } from '@lobster/shared-types';

import { rendererPresetById } from '../src/features/profiles/fingerprintCatalog';
import { OS_OPTIONS } from '../src/features/profiles/options';

const baseUrl = process.env.LOBSTER_E2E_URL ?? 'http://127.0.0.1:5181/';

/** The OS picker is a custom listbox (it draws a platform glyph per option), so drive it by hand. */
async function selectOs(dialog: Locator, label: string): Promise<void> {
  await dialog.getByRole('button', { name: 'Operating system' }).click();
  await dialog.getByRole('option', { name: label, exact: true }).click();
}

async function selectedOs(dialog: Locator): Promise<ProfileOsTarget> {
  const label = (await dialog.getByRole('button', { name: 'Operating system' }).innerText()).trim();
  const option = OS_OPTIONS.find((entry) => entry.label === label);
  if (!option) throw new Error(`Unknown operating system label: ${label}`);
  return option.value;
}

test('desktop UI smoke: profiles, filters, trash, proxies, and templates', async ({ page }) => {
  await page.goto(baseUrl);
  await expect(page.getByRole('button', { name: 'Profiles' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Profiles' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('button', { name: 'Pricing' })).toHaveCount(0);
  await expect(page.getByTitle('Toggle theme')).toHaveCount(0);

  const profileName = `E2E Policy ${Date.now()}`;
  await page.getByRole('button', { name: 'Create Profile' }).click();
  const dialog = page.getByRole('dialog', { name: 'New profile' });
  await page.getByPlaceholder('Enter profile name').fill(profileName);
  await page.getByPlaceholder('Enter description').fill('Policy smoke profile');
  await page.getByPlaceholder('Tags').fill('e2e, policy');

  await page.getByRole('tab', { name: 'Fingerprint' }).click();
  await selectOs(dialog, 'Windows');
  await page.getByLabel('OS version').selectOption('Windows 11');
  await expect(page.getByLabel('User Agent')).toHaveValue(/Chrome\//);
  await page.getByLabel('Geolocation').selectOption('manual');
  await dialog.getByRole('textbox', { name: 'Location', exact: true }).fill('New York');
  await dialog.getByRole('option', { name: 'New York, United States' }).click();
  await expect(dialog.getByText('lat 40.7128, lng -74.006')).toBeVisible();
  await page.getByLabel(/Client rects/i).check();
  await page.getByLabel('Cameras').fill('2');
  await page.getByLabel('Speakers').fill('3');

  await page.getByRole('tab', { name: 'Cookies' }).click();
  await page
    .getByPlaceholder('Paste cookie text')
    .fill('[{"name":"sid","value":"abc","domain":"example.com","path":"/"}]');
  await expect(page.getByText('1 cookies detected')).toBeVisible();

  await page.getByRole('tab', { name: 'Security' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeEnabled();

  await page.getByRole('tab', { name: 'Extensions' }).click();
  await page
    .getByPlaceholder('abcdefghijklmnopabcdefghijklmnop')
    .fill('abcdefghijklmnopabcdefghijklmnop');
  await page.getByRole('button', { name: 'Add extension' }).click();
  await dialog.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.getByText(profileName, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByLabel('Engine').selectOption('lobium');
  await page.getByLabel('Tag').fill('policy');
  await expect(page.getByText(profileName, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset' }).click();

  await page.getByLabel(`More actions for ${profileName}`).click();
  await page.getByRole('menuitem', { name: 'Set a password' }).click();
  await page.getByLabel('New password').fill('secret-pass');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByText('Password protection enabled.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: profileName })).toContainText('Locked');

  await page.getByLabel(`More actions for ${profileName}`).click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await page.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.getByText('Profile moved to trash.')).toBeVisible();
  await expect(page.getByText(profileName, { exact: true })).not.toBeVisible();

  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  const trash = page.getByRole('dialog', { name: /^Trash/ });
  await expect(trash).toBeVisible();
  await expect(trash.getByText(profileName, { exact: true })).toBeVisible();
  await trash.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Profile restored.')).toBeVisible();
  await trash.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText(profileName, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Proxies' }).click();
  await page.getByRole('button', { name: 'Add Proxy' }).click();
  await page.getByLabel('Title').fill('E2E Proxy');
  await page.getByPlaceholder('Enter IP or domain').fill('proxy.example.test');
  await page.getByLabel('Port').fill('1080');
  await page
    .getByRole('dialog', { name: 'Add proxy' })
    .getByRole('button', { name: 'Add proxy' })
    .click();
  await expect(page.getByText('E2E Proxy')).toBeVisible();

  await page.getByRole('button', { name: 'Templates' }).click();
  await page.getByRole('button', { name: 'Create Template' }).click();
  await page.getByPlaceholder('Template name').fill('E2E Template');
  await page.getByLabel('Tags').fill('e2e');
  await page
    .getByRole('dialog', { name: 'Create template' })
    .getByRole('button', { name: 'Create template' })
    .click();
  await expect(page.getByText('E2E Template', { exact: true })).toBeVisible();
});

test('profile wizard validates hidden sections, tests proxy, and restores focus', async ({
  page,
}) => {
  await page.goto(baseUrl);
  const opener = page.getByRole('button', { name: 'Create Profile' }).first();
  await opener.click();

  const dialog = page.getByRole('dialog', { name: 'New profile' });
  await dialog.getByRole('button', { name: 'Create profile' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter a profile name');

  await page.getByPlaceholder('Enter profile name').fill('Validation profile');
  await dialog.getByRole('combobox', { name: 'Proxy', exact: true }).selectOption('__custom__');
  await dialog.getByLabel('Proxy title').fill('Validated proxy');
  await dialog.getByLabel('Host').fill('proxy.example.test');
  await dialog.getByLabel('Port').fill('1080');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status')).toContainText('Connected');

  await page.getByRole('tab', { name: 'Extensions' }).click();
  await page
    .getByPlaceholder('abcdefghijklmnopabcdefghijklmnop')
    .fill('http://invalid.example/extension');
  await page.getByRole('button', { name: 'Add extension' }).click();
  await expect(dialog.getByRole('alert')).toContainText('valid Chrome Web Store ID');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('profile wizard creates an editable Android device profile', async ({ page }) => {
  await page.goto(baseUrl);
  const name = `E2E Android ${Date.now()}`;
  await page.getByRole('button', { name: 'Create Profile' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New profile' });
  await page.getByPlaceholder('Enter profile name').fill(name);
  await page.getByRole('tab', { name: 'Fingerprint' }).click();
  await selectOs(dialog, 'Android');
  await expect(page.getByLabel('Device type')).toBeEnabled();
  await page.getByLabel('Device type').selectOption('tablet');
  await expect(page.getByLabel('Device model')).toBeEnabled();
  await expect(page.getByLabel('Device model')).not.toHaveValue('');
  await page.getByLabel('Device model').focus();
  await expect(dialog.getByRole('listbox').getByRole('option')).not.toHaveCount(1);
  await page.getByLabel('Device model').fill('Samsung');
  await expect(dialog.getByRole('listbox').getByRole('option').first()).toBeVisible();
  await dialog.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
});

test('narrow shell keeps keyboard navigation and modal focus accessible', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 720 });
  await page.goto(baseUrl);

  const paletteButton = page.getByRole('banner').getByRole('button');
  await expect(paletteButton).toBeVisible();
  await paletteButton.click();

  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await expect(page.getByLabel('Command search')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(palette.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(paletteButton).toBeFocused();

  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await expect(page.getByRole('button', { name: 'Profiles' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('fingerprint edit preserves the validated per-OS renderer and other profile overrides', async ({
  page,
}) => {
  await page.goto(baseUrl);
  const profileName = `E2E Preserve ${Date.now()}`;
  await page.getByRole('button', { name: 'Create Profile' }).click();
  await page.getByPlaceholder('Enter profile name').fill(profileName);
  await page
    .getByRole('dialog', { name: 'New profile' })
    .getByRole('button', { name: 'Create profile' })
    .click();
  await expect(page.getByText(profileName, { exact: true })).toBeVisible();

  async function openProfileEditor(): Promise<void> {
    await page.getByLabel(`More actions for ${profileName}`).click();
    await page.getByRole('menuitem', { name: 'Edit profile' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit profile' })).toBeVisible();
    await page.getByRole('tab', { name: 'Fingerprint' }).click();
  }

  await openProfileEditor();
  const dialog = page.getByRole('dialog', { name: 'Edit profile' });
  // A profile created with default settings leaves its machine to its seed, so the device pickers sit
  // behind the advanced choice. Pinning is what writes a renderer into the profile at all.
  await expect(dialog.getByLabel('Device source')).toHaveValue('seed');
  await dialog.getByLabel('Device source').selectOption('pinned');
  const renderer = dialog.getByLabel('WebGL renderer');
  const rendererPreset = await renderer.inputValue();
  expect(rendererPresetById(await selectedOs(dialog), rendererPreset)).toBeTruthy();
  await dialog.getByLabel('Speakers').fill('4');
  await dialog.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();

  await openProfileEditor();
  await expect(dialog.getByLabel('Speakers')).toHaveValue('4');
  await expect(dialog.getByLabel('Device source')).toHaveValue('pinned');
  await expect(dialog.getByLabel('WebGL renderer')).toHaveValue(rendererPreset);
});

// Fixed-width columns are sized to the controls they hold, so a change to button padding silently
// pushes the last column past the table box and clips its actions. That has regressed twice; this
// measures it instead of trusting the numbers.
test('data tables fit their container at every supported width', async ({ page }) => {
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const screen of ['Profiles', 'Proxies', 'Templates']) {
      await page.goto(baseUrl);
      await page.getByRole('button', { name: screen, exact: true }).click();
      const overflow = await page.evaluate(() => {
        const table = document.querySelector('table');
        const panel = table?.parentElement;
        return panel ? panel.scrollWidth - panel.clientWidth : 0;
      });
      expect(overflow, `${screen} at ${width}px overflows its panel by ${overflow}px`).toBe(0);
    }
  }
});
