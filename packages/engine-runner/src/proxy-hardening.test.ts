/**
 * Unit tests for proxy fail-closed Chromium args (PROX-7/8).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildProxyBypassList, buildProxyHardeningArgs } from './proxy-hardening.js';

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
    assert.ok(args.includes('--proxy-bypass-list=<-loopback>'));
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

  it('re-adds a first-party loopback endpoint AFTER <-loopback>, never before it', () => {
    // `<-loopback>` strips the loopback bypasses accumulated before it, so an endpoint listed first is
    // silently erased and the Lobee panel still cannot reach its own sidecar. Verified against Lobium
    // 152 with a dead upstream: `127.0.0.1:P;<-loopback>` is blocked, `<-loopback>;127.0.0.1:P` is not.
    const args = buildProxyHardeningArgs(
      { id: 'p4', type: 'http', host: 'proxy.example', port: 8080 },
      { loopbackAllowlist: ['127.0.0.1:45231'] },
    );
    assert.ok(args.includes('--proxy-bypass-list=<-loopback>;127.0.0.1:45231'));
    // Guard the ordering explicitly: this is the whole fix, and reversing it fails silently at runtime.
    const list = args
      .find((a) => a.startsWith('--proxy-bypass-list='))!
      .slice('--proxy-bypass-list='.length)
      .split(';');
    assert.equal(list.indexOf('<-loopback>'), 0);
  });

  it('drops anything that is not an exact loopback host:port from the bypass list', () => {
    // A malformed or over-broad entry must never widen the bypass; dropping it only sends more
    // traffic through the tunnel, which is the safe direction.
    assert.equal(
      buildProxyBypassList([
        'evil.example.com',
        '*',
        '<local>',
        '10.0.0.5:8080',
        '127.0.0.1',
        '127.0.0.1:0',
        '127.0.0.1:70000',
        '127.0.0.1:45231',
        '127.0.0.1:45231',
        '[::1]:45231',
      ]),
      '<-loopback>;127.0.0.1:45231;[::1]:45231',
    );
    assert.equal(buildProxyBypassList(), '<-loopback>');
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
