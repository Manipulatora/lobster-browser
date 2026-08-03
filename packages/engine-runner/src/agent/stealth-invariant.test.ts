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
// `dist/agent`, so step back to the package root and into `src`.
const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'agent');
/**
 * The scan covers the WHOLE sidecar source tree, not just `src/agent`.
 *
 * It used to stop at the agent directory, which left out the files that actually put bytes on the
 * DevTools socket: `cdp-client.ts` (every command the product sends goes through it), `humanize.ts`
 * (the `Input.*` dispatch), `cookie-inject.ts`, `mobile-emulation.ts`, and the host-calibration
 * probes. The guard was watching the callers and not the caller's transport. The tree is clean today,
 * so widening it costs nothing now and is the whole point later.
 */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/**
 * `Target.setAutoAttach` / `setDiscoverTargets` are browser-target commands and not page-observable,
 * but they are in the same family and worth naming explicitly so any future use is a deliberate,
 * reviewed decision rather than an accident.
 */
const FORBIDDEN =
  /\b(Runtime|Page|DOM|Network|Log|Console|Debugger|Performance|Security|Fetch|Animation|CSS|Overlay|Accessibility|DOMStorage|Database|Audits|Emulation)\.enable\b/;

/** Every non-test `.ts` under `src`, recursively. */
async function sidecarSources(dir = SRC_DIR, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await sidecarSources(join(dir, entry.name), rel)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(rel);
  }
  return out;
}

test('no sidecar source enables a DevTools domain', async () => {
  const offenders: string[] = [];
  const scanned = await sidecarSources();
  // A scan that silently matched nothing would pass forever; assert it actually reached the transport.
  assert.ok(scanned.includes('cdp-client.ts'), 'the scan must cover the raw CDP client');
  assert.ok(scanned.includes('humanize.ts'), 'the scan must cover the Input.* dispatch');
  assert.ok(scanned.length > 30, `expected the whole tree, scanned ${scanned.length} files`);
  for (const name of scanned) {
    const source = await readFile(join(SRC_DIR, name), 'utf8');
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
    `CDP domain enable found in the sidecar — this makes the session detectable:\n${offenders.join('\n')}`,
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
