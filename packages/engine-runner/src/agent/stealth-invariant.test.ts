import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * The anti-detect invariant, enforced mechanically.
 *
 * Attaching the agent must add NO automation tell to a session, which means never enabling a CDP
 * domain on a page target: `Runtime.enable`, `Page.enable`, `DOM.enable`, `Network.enable` and friends
 * all make the session observable to the page. Every capability the driver needs is reachable with
 * one-shot commands instead (`Runtime.evaluate`, `Input.*`, `Page.navigate`, …).
 *
 * Until now this was documented in comments and honoured by discipline, with nothing to catch a
 * regression — and a single `Runtime.enable` added in a hurry would silently cost the product its core
 * guarantee, in a way no functional test would notice. This is that missing check.
 */

// This test reads SOURCE, not the compiled output — the invariant is about what we write. It runs from
// `dist/agent`, so step back to the package root and into `src/agent`.
const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'agent');

/**
 * `Target.setAutoAttach` / `setDiscoverTargets` are browser-target commands and not page-observable,
 * but they are in the same family and worth naming explicitly so any future use is a deliberate,
 * reviewed decision rather than an accident.
 */
const FORBIDDEN =
  /\b(Runtime|Page|DOM|Network|Log|Console|Debugger|Performance|Security|Fetch|Animation|CSS|Overlay|Accessibility|DOMStorage|Database|Audits|Emulation)\.enable\b/;

async function agentSources(): Promise<string[]> {
  const names = await readdir(AGENT_DIR);
  return names.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
}

test('the agent CDP layer never enables a DevTools domain', async () => {
  const offenders: string[] = [];
  for (const name of await agentSources()) {
    const source = await readFile(join(AGENT_DIR, name), 'utf8');
    source.split('\n').forEach((line, index) => {
      // Skip prose: the invariant is *described* in several doc comments, which must not trip it.
      const code = line.replace(/\/\/.*$/, '');
      if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) return;
      if (FORBIDDEN.test(code)) offenders.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `CDP domain enable found in the agent driver — this makes the session detectable:\n${offenders.join('\n')}`,
  );
});

test('privileged WebUI evaluation stays confined to a throwaway settings page', async () => {
  const source = await readFile(join(AGENT_DIR, 'cdp-driver.ts'), 'utf8');

  // `chrome.settingsPrivate` is only reachable from a WebUI page context. The only sanctioned way in is
  // `withSettingsPage`, which creates a background target and closes it; anything else would mean the
  // agent evaluating privileged JS somewhere it should not.
  const settingsPrivateUses = source.split('\n').filter((line) => line.includes('settingsPrivate'));
  assert.ok(settingsPrivateUses.length > 0, 'expected the pref path to exist');

  const start = source.indexOf('private async withSettingsPage');
  const helper = source.slice(start, source.indexOf('private async waitForTargetWs', start));
  assert.ok(helper.length > 0, 'expected to find the withSettingsPage helper');
  assert.match(helper, /background: true/, 'the settings page must never be shown to the user');
  assert.match(helper, /Target\.closeTarget/, 'the scratch settings page must always be closed');

  // It must not become the agent's working target: that would silently move the agent off the page the
  // task is about.
  assert.doesNotMatch(helper, /this\.switchTo\(/);
  assert.doesNotMatch(helper, /Target\.activateTarget/);
});
