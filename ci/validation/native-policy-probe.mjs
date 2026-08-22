#!/usr/bin/env node
/**
 * Deterministic native-policy probe. Patchright is used only to attach/control and grant geolocation
 * permission; no Emulation fingerprint override or init script is installed.
 *
 * Requires a Lobium rebuild containing the capability contract and current patches/series.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyGeoToFingerprint, deriveFingerprint } from '@lobster/fingerprint';
import {
  buildGpuArgs,
  buildLobiumConfig,
  lobiumConfigArg,
  probeLobiumBuildCapabilities,
  resolveLobiumBinary,
  writeLobiumConfig,
} from '@lobster/engine-runner';
import { chromium } from 'patchright';

const binary = resolveLobiumBinary();
const policies = [
  'default_public_interface_only',
  'disable_non_proxied_udp',
  'proxy_only',
  'disabled',
];

function startServer() {
  const server = createServer((req, res) => {
    if (req.url === '/worker.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(
        `self.onmessage=async()=>{const h=await(await fetch('/headers')).json();self.postMessage({languages:[...navigator.languages],` +
          `language:navigator.language,locale:Intl.DateTimeFormat().resolvedOptions().locale,` +
          `timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,` +
          `acceptLanguage:h.acceptLanguage})};`,
      );
      return;
    }
    if (req.url === '/shared-worker.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(
        `self.onconnect=e=>{const p=e.ports[0];p.onmessage=async()=>{const h=await(await fetch('/headers')).json();p.postMessage({` +
          `languages:[...navigator.languages],language:navigator.language,` +
          `locale:Intl.DateTimeFormat().resolvedOptions().locale,` +
          `timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,` +
          `acceptLanguage:h.acceptLanguage})};p.start()};`,
      );
      return;
    }
    if (req.url === '/service-worker.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(
        `self.onmessage=async e=>{const h=await(await fetch('/headers')).json();` +
          `e.source.postMessage({kind:'service',languages:[...navigator.languages],` +
          `language:navigator.language,locale:Intl.DateTimeFormat().resolvedOptions().locale,` +
          `timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,acceptLanguage:h.acceptLanguage})};`,
      );
      return;
    }
    if (req.url === '/headers') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ acceptLanguage: req.headers['accept-language'] || '' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>native policy probe</title><body>probe</body>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function endpoint(userDataDir) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const [port, path] = (await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8'))
        .trim()
        .split('\n');
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {
      // Browser is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for Lobium');
}

async function runPolicy(policy, origin) {
  const fp = applyGeoToFingerprint(
    deriveFingerprint(`native-policy-${policy}`, { os: 'linux', engine: 'lobium' }),
    {
      ip: '0.0.0.0',
      countryCode: 'DE',
      timezone: 'Europe/Berlin',
      latitude: 52.52,
      longitude: 13.405,
    },
  );
  const userDataDir = await mkdtemp(join(tmpdir(), `lobium-native-${policy}-`));
  await mkdir(join(userDataDir, 'Default'), { recursive: true });
  await writeFile(
    join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({
      intl: {
        accept_languages: fp.navigator.languages.join(','),
        selected_languages: fp.navigator.languages.join(','),
      },
    }),
  );
  await writeFile(
    join(userDataDir, 'Local State'),
    JSON.stringify({ intl: { app_locale: fp.locale.locale } }),
  );
  const config = buildLobiumConfig(fp, {
    seed: `native-policy-${policy}`,
    webrtcPolicy: policy,
    ...(policy === 'proxy_only'
      ? { proxy: { type: 'http', host: 'proxy.invalid', port: 8080 } }
      : {}),
    hardwareNoise: { clientRects: true },
    mediaDevices: { cameras: 2, microphones: 1, speakers: 2, stableDeviceIds: true },
  });
  const configPath = await writeLobiumConfig(userDataDir, config);
  const forcedPolicy =
    policy === 'default_public_interface_only'
      ? 'default_public_interface_only'
      : 'disable_non_proxied_udp';
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    `--lang=${fp.locale.locale}`,
    `--webrtc-ip-handling-policy=${forcedPolicy}`,
    '--disable-features=ReduceAcceptLanguage',
    lobiumConfigArg(configPath),
    ...buildGpuArgs({ mode: 'software' }),
    `${origin}/`,
  ];
  const processLocale = `${fp.locale.locale.replaceAll('-', '_')}.UTF-8`;
  const child = spawn(binary, args, {
    stdio: 'ignore',
    env: { ...process.env, TZ: fp.locale.timezone, LANG: processLocale, LC_ALL: processLocale },
  });
  try {
    const browser = await chromium.connectOverCDP(await endpoint(userDataDir));
    try {
      const context = browser.contexts()[0];
      await context.grantPermissions(['geolocation'], { origin });
      const page = context.pages()[0] || (await context.newPage());
      await page.goto(`${origin}/`);
      const observed = await page.evaluate(async ({ expectedPolicy }) => {
        const contextValues = () => ({
          languages: [...navigator.languages],
          language: navigator.language,
          locale: Intl.DateTimeFormat().resolvedOptions().locale,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        const worker = await new Promise((resolve) => {
          const instance = new Worker('/worker.js');
          instance.onmessage = (event) => resolve(event.data);
          instance.postMessage(null);
        });
        const shared = await new Promise((resolve) => {
          const instance = new SharedWorker('/shared-worker.js');
          instance.port.onmessage = (event) => resolve(event.data);
          instance.port.start();
          instance.port.postMessage(null);
        });
        const registration = await navigator.serviceWorker.register('/service-worker.js');
        const pendingWorker = registration.installing || registration.waiting || registration.active;
        if (pendingWorker && pendingWorker.state !== 'activated') {
          await new Promise((resolve) => {
            pendingWorker.addEventListener('statechange', () => {
              if (pendingWorker.state === 'activated') resolve();
            });
          });
        }
        const service = await new Promise((resolve) => {
          const onMessage = (event) => {
            if (event.data?.kind === 'service') {
              navigator.serviceWorker.removeEventListener('message', onMessage);
              resolve(event.data);
            }
          };
          navigator.serviceWorker.addEventListener('message', onMessage);
          const active = registration.active || registration.waiting;
          if (!active) throw new Error('service worker did not activate');
          active.postMessage(null);
        });
        const mainHeader = (await (await fetch('/headers')).json()).acceptLanguage;
        const iframe = await new Promise((resolve) => {
          const frame = document.createElement('iframe');
          frame.onload = () => resolve({
            languages: [...frame.contentWindow.navigator.languages],
            language: frame.contentWindow.navigator.language,
            locale: frame.contentWindow.Intl.DateTimeFormat().resolvedOptions().locale,
            timezone: frame.contentWindow.Intl.DateTimeFormat().resolvedOptions().timeZone,
          });
          frame.src = '/';
          document.body.append(frame);
        });
        const geolocation = await new Promise((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(
            (position) =>
              resolve({
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy,
              }),
            reject,
            { timeout: 5_000 },
          ),
        );
        let webRtc = { constructor: 'ok', candidateTypes: [], configuredType: null };
        try {
          const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
          });
          webRtc.configuredType = pc.getConfiguration().iceTransportPolicy;
          pc.createDataChannel('probe');
          pc.onicecandidate = (event) => {
            if (event.candidate?.type) webRtc.candidateTypes.push(event.candidate.type);
          };
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          pc.close();
        } catch (error) {
          webRtc = { constructor: error.name || 'error', candidateTypes: [], configuredType: null };
        }
        const rect = document.body.getBoundingClientRect();
        const rectAgain = document.body.getBoundingClientRect();
        const devices = await navigator.mediaDevices.enumerateDevices();
        const devicesAgain = await navigator.mediaDevices.enumerateDevices();
        return {
          expectedPolicy,
          contexts: { main: contextValues(), iframe, worker, shared, service },
          headers: { main: mainHeader, worker: worker.acceptLanguage, shared: shared.acceptLanguage, service: service.acceptLanguage },
          geolocation,
          webRtc,
          clientRect: rect.toJSON(),
          clientRectsStable: JSON.stringify(rect.toJSON()) === JSON.stringify(rectAgain.toJSON()),
          media: {
            kinds: devices.map((device) => device.kind),
            ids: devices.map((device) => device.deviceId),
            stableIds:
              devices.every((device) => device.deviceId.length > 0) &&
              devices.map((device) => device.deviceId).join(',') ===
                devicesAgain.map((device) => device.deviceId).join(','),
          },
        };
      }, { expectedPolicy: policy });
      const expectedLanguage = fp.navigator.languages.join(',');
      const expectedHeader = fp.locale.acceptLanguage;
      const contextPass = Object.values(observed.contexts).every(
        (value) =>
          value.languages.join(',') === expectedLanguage &&
          value.language === fp.navigator.languages[0] &&
          value.locale === fp.locale.locale &&
          value.timezone === fp.locale.timezone,
      );
      const headersPass = Object.values(observed.headers).every(
        (value) => value === expectedHeader,
      );
      const geoPass =
        observed.geolocation.latitude === fp.locale.geolocation.latitude &&
        observed.geolocation.longitude === fp.locale.geolocation.longitude;
      const webRtcPass =
        policy === 'disabled'
          ? observed.webRtc.constructor === 'NotSupportedError'
          : policy === 'proxy_only'
            ? observed.webRtc.configuredType === 'relay' &&
              observed.webRtc.candidateTypes.every((type) => type === 'relay')
            : observed.webRtc.constructor === 'ok';
      return {
        policy,
        checks: {
          contextPass,
          headersPass,
          geoPass,
          webRtcPass,
          clientRectsStable: observed.clientRectsStable,
          mediaStable: observed.media.stableIds,
        },
        observed,
      };
    } finally {
      await browser.close();
    }
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

async function main() {
  if (!binary || !existsSync(binary)) throw new Error('Lobium binary not found');
  const capabilities = await probeLobiumBuildCapabilities(binary);
  const { server, origin } = await startServer();
  try {
    const results = [];
    for (const policy of policies) results.push(await runPolicy(policy, origin));
    const crossProfile = {
      clientRectsDistinct:
        new Set(results.map((result) => JSON.stringify(result.observed.clientRect))).size ===
        results.length,
      mediaIdsDistinct:
        new Set(results.map((result) => result.observed.media.ids.join(','))).size ===
        results.length,
    };
    const pass =
      results.every((result) => Object.values(result.checks).every(Boolean)) &&
      Object.values(crossProfile).every(Boolean);
    process.stdout.write(
      `${JSON.stringify({ capabilities, results, crossProfile, verdict: pass ? 'pass' : 'fail' }, null, 2)}\n`,
    );
    if (!pass) process.exitCode = 1;
  } finally {
    server.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
});
