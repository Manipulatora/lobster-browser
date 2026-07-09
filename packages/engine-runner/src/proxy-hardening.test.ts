/**
 * Unit tests for proxy fail-closed Chromium args (PROX-7/8).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildProxyHardeningArgs } from './proxy-hardening.js';

describe('buildProxyHardeningArgs', () => {
  it('emits nothing without a proxy', () => {
    assert.deepEqual(buildProxyHardeningArgs(undefined), []);
  });

  it('emits QUIC + AsyncDns disables for HTTP proxy', () => {
    const args = buildProxyHardeningArgs({
      id: 'p1',
      type: 'http',
      host: 'proxy.example',
      port: 8080,
    });
    assert.ok(args.includes('--disable-quic'));
    assert.ok(args.some((a) => a.includes('AsyncDns')));
  });

  it('emits the same fail-closed set for SOCKS5', () => {
    const args = buildProxyHardeningArgs({
      id: 'p2',
      type: 'socks5',
      host: 'socks.example',
      port: 1080,
    });
    assert.ok(args.includes('--disable-quic'));
  });

  it('can be opted out via killSwitch:false', () => {
    assert.deepEqual(
      buildProxyHardeningArgs(
        { id: 'p3', type: 'http', host: 'h', port: 1 },
        { killSwitch: false },
      ),
      [],
    );
  });
});
