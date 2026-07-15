import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('quilt series wires every capability-gated native patch', async () => {
  const series = await read('lobium/patches/series');
  for (const patch of [
    'core/capability-contract.patch',
    'fingerprint/locale-geolocation.patch',
    'fingerprint/host-gpu-profile.patch',
    'fingerprint/client-rects.patch',
    'fingerprint/media-devices.patch',
    'fingerprint/webrtc-policy.patch',
  ]) {
    assert.match(series, new RegExp(`^${patch.replaceAll('.', '\\.')}$`, 'm'));
  }
});

test('exact-build manifest and TypeScript contract stay synchronized', async () => {
  const [nativePatch, contract] = await Promise.all([
    read('lobium/patches/core/capability-contract.patch'),
    read('packages/engine-runner/src/lobium-capabilities.ts'),
  ]);
  for (const capability of [
    'config-channel-v1',
    'navigator-languages',
    'network-accept-language',
    'process-locale-timezone',
    'native-geolocation',
    'webrtc-policy',
    'webgl-deep',
    'canvas-farbling',
    'webgl-farbling',
    'audio-farbling',
    'client-rects',
    'media-devices',
  ]) {
    assert.ok(nativePatch.includes(`\\"${capability}\\"`), `native manifest missing ${capability}`);
    assert.ok(contract.includes(`'${capability}'`), `TypeScript contract missing ${capability}`);
  }
});

test('locale/geolocation and WebRTC patches enforce the intended native semantics', async () => {
  const [locale, webrtc] = await Promise.all([
    read('lobium/patches/fingerprint/locale-geolocation.patch'),
    read('lobium/patches/fingerprint/webrtc-policy.patch'),
  ]);
  assert.match(locale, /NavigatorLanguage::EnsureUpdatedLanguage/);
  assert.match(locale, /RenderThreadImpl::Init/);
  assert.match(locale, /SetICUDefaultLocale\(cfg->locale\.locale\)/);
  assert.match(locale, /cfg->navigator\.languages/);
  assert.match(locale, /cfg->locale\.has_geolocation/);
  assert.match(locale, /normal browser permission service has granted access/);
  assert.match(webrtc, /cfg->net\.webrtc_policy == "disabled"/);
  assert.match(webrtc, /configuration\.type = webrtc::PeerConnectionInterface::kRelay/);
  assert.match(webrtc, /platform_candidate->Type\(\) != "relay"/);

  const farble = await read('lobium/src/lobium_farble.cc');
  assert.match(farble, /constexpr float kUnit = 1\.0f \/ 64\.0f/);
  assert.match(farble, /\*x \+= delta/);
});

test('production native detector no longer installs the compatibility overlay', async () => {
  const detector = await read('ci/validation/lobium-detect.mjs');
  assert.doesNotMatch(detector, /applyCdpFingerprint/);
  assert.match(detector, /probeLobiumBuildCapabilities/);

  const probe = await read('ci/validation/native-policy-probe.mjs');
  for (const context of ['iframe', 'worker', 'shared', 'service']) {
    assert.ok(probe.includes(context), `native probe missing ${context} context`);
  }
  assert.match(probe, /clientRectsDistinct/);
  assert.match(probe, /mediaIdsDistinct/);
});
