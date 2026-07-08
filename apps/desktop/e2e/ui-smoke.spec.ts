import { expect, test } from '@playwright/test';

const baseUrl = process.env.LOBSTER_E2E_URL ?? 'http://127.0.0.1:5181/';

test('desktop UI smoke: profiles, filters, trash, proxies, templates, pricing', async ({
  page,
}) => {
  page.on('dialog', (dialog) =>
    dialog.type() === 'prompt' ? dialog.accept('secret-pass') : dialog.accept(),
  );

  await page.goto(baseUrl);
  await expect(page.getByText('Lobster').first()).toBeVisible();

  const profileName = `E2E Policy ${Date.now()}`;
  await page.getByRole('button', { name: 'Create Profile' }).click();
  await page.getByPlaceholder('Enter profile name').fill(profileName);
  await page.getByPlaceholder('Enter description').fill('Policy smoke profile');
  await page.getByPlaceholder('Tags').fill('e2e, policy');

  await page.getByRole('button', { name: 'Fingerprint' }).click();
  await page.getByLabel('Engine').selectOption('lobium');
  await page.getByLabel('Operating system').selectOption('windows');
  await page.getByLabel('OS version').selectOption('Windows 11 23H2');
  await page.getByLabel('Geolocation latitude').fill('40.7128');
  await page.getByLabel('Geolocation longitude').fill('-74.0060');
  await page.getByLabel('Renderer').selectOption('normalized_host');
  await page.getByLabel('Client Rects').check();
  await page.getByLabel('Cameras').fill('2');
  await page.getByLabel('Speakers').fill('3');

  await page.getByRole('button', { name: 'Cookies' }).click();
  await page
    .getByPlaceholder('Paste cookie text')
    .fill('[{"name":"sid","value":"abc","domain":"example.com","path":"/"}]');
  await expect(page.getByText('1 cookies detected')).toBeVisible();

  await page.getByRole('button', { name: 'Security' }).click();
  await page.getByLabel('WebRTC').selectOption('proxy_only');

  await page.getByRole('button', { name: 'Extensions' }).click();
  await page
    .getByPlaceholder('https://chromewebstore.google.com/detail/...')
    .fill('https://chromewebstore.google.com/detail/example');
  await page.getByLabel('Create profile').getByRole('button', { name: 'Create Profile' }).click();
  await expect(page.getByText(profileName, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByLabel('Engine').selectOption('lobium');
  await page.getByLabel('Tag').fill('policy');
  await expect(page.getByText(profileName, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset' }).click();

  await page.getByLabel(`More actions for ${profileName}`).click();
  await page.getByRole('menuitem', { name: 'Set/remove pwd' }).click();
  await expect(page.getByText('Password protection enabled.')).toBeVisible();
  await expect(page.getByText('Password protected')).toBeVisible();

  await page.getByLabel(`More actions for ${profileName}`).click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await expect(page.getByText('Profile moved to trash.')).toBeVisible();
  await expect(page.getByText(profileName, { exact: true })).not.toBeVisible();

  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Trash' }).click();
  await expect(page.getByRole('dialog', { name: 'Trash' })).toBeVisible();
  await expect(page.getByText(profileName, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Profile restored.')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText(profileName, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Proxies' }).click();
  await page.getByRole('button', { name: 'Add Proxy' }).click();
  await page.getByLabel('Title').fill('E2E Proxy');
  await page.getByPlaceholder('Enter IP or domain').fill('proxy.example.test');
  await page.getByLabel('Port').fill('1080');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('E2E Proxy')).toBeVisible();

  await page.getByRole('button', { name: 'Templates' }).click();
  await page.getByRole('button', { name: 'Create Template' }).click();
  await page.getByPlaceholder('Template name').fill('E2E Template');
  await page.getByLabel('Tags').fill('e2e');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('E2E Template', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Pricing' }).click();
  await expect(page.getByText('Team')).toBeVisible();
});
