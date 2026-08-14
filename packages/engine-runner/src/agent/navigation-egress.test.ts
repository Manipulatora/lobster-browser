import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNavigationEgressPreflight,
  isPrivateOrSpecialAddress,
  type ProfileNetworkRoute,
  type ResolveAddresses,
} from './navigation-egress.js';
import { forgetProfile, provisionProfile, resolveProfileNetworkRoute } from './bridge-registry.js';

test('private/special IP classification covers IPv4, IPv6, and embedded forms', () => {
  for (const address of [
    '127.0.0.1',
    '10.2.3.4',
    '100.64.0.1',
    '169.254.169.254',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1%lo0',
    'ff02::1',
    '::ffff:127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:0001::',
    '2001:db8::1',
  ]) {
    assert.equal(isPrivateOrSpecialAddress(address), true, address);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPrivateOrSpecialAddress(address), false, address);
  }
});

test('direct profiles resolve every hostname and allow only wholly public answers', async () => {
  const lookups: string[] = [];
  const resolve: ResolveAddresses = async (hostname) => {
    lookups.push(hostname);
    return [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
  };
  const guard = createNavigationEgressPreflight({
    route: () => 'direct',
    allowPrivateNetwork: false,
    resolve,
  });
  await guard('https://Example.COM./path');
  assert.deepEqual(lookups, ['example.com']);
});

test('direct profiles fail closed when any DNS answer is private', async () => {
  const guard = createNavigationEgressPreflight({
    route: () => 'direct',
    allowPrivateNetwork: false,
    resolve: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ],
  });
  await assert.rejects(
    guard('https://public-looking.example/resource'),
    /DNS for public-looking\.example resolved to a private or special address/,
  );
});

test('direct profiles fail closed on DNS errors, empty/invalid answers, and timeout', async () => {
  const cases: Array<{ resolve: ResolveAddresses; pattern: RegExp; timeoutMs?: number }> = [
    {
      resolve: async () => Promise.reject(new Error('NXDOMAIN with secret resolver detail')),
      pattern: /could not resolve safe\.example/,
    },
    { resolve: async () => [], pattern: /returned no addresses/ },
    {
      resolve: async () => [{ address: 'not-an-ip', family: 4 }],
      pattern: /returned an invalid address/,
    },
    {
      resolve: () => new Promise(() => {}),
      pattern: /timed out/,
      timeoutMs: 10,
    },
  ];
  for (const scenario of cases) {
    const guard = createNavigationEgressPreflight({
      route: () => 'direct',
      allowPrivateNetwork: false,
      resolve: scenario.resolve,
      ...(scenario.timeoutMs ? { timeoutMs: scenario.timeoutMs } : {}),
    });
    await assert.rejects(guard('https://safe.example/'), scenario.pattern);
  }
});

test('remote-proxy profiles never perform a misleading local DNS lookup', async () => {
  let calls = 0;
  const guard = createNavigationEgressPreflight({
    route: () => 'remote-proxy',
    allowPrivateNetwork: false,
    resolve: async () => {
      calls += 1;
      throw new Error('must not be called');
    },
  });
  await guard('https://service.available.only.at.proxy.example/');
  await guard('https://[2606:4700:4700::1111]/');
  assert.equal(calls, 0);
});

test('literal, local, and bare destinations are blocked without lookup in every route mode', async () => {
  for (const route of ['direct', 'remote-proxy', 'unknown'] satisfies ProfileNetworkRoute[]) {
    let calls = 0;
    const guard = createNavigationEgressPreflight({
      route: () => route,
      allowPrivateNetwork: false,
      resolve: async () => {
        calls += 1;
        return [{ address: '1.1.1.1', family: 4 }];
      },
    });
    for (const url of [
      'http://127.0.0.1/',
      'http://[::ffff:7f00:1]/',
      'http://metadata.internal/',
      'http://printer/',
      'http://host.home.arpa/',
    ]) {
      await assert.rejects(guard(url), /navigation blocked/);
    }
    assert.equal(calls, 0, route);
  }
});

test('an unknown route fails closed for DNS names, while explicit private-network opt-in bypasses', async () => {
  const unknown = createNavigationEgressPreflight({
    route: () => 'unknown',
    allowPrivateNetwork: false,
    resolve: async () => [{ address: '1.1.1.1', family: 4 }],
  });
  await assert.rejects(unknown('https://example.com/'), /network route is unknown/);

  let calls = 0;
  const optedIn = createNavigationEgressPreflight({
    route: () => 'direct',
    allowPrivateNetwork: true,
    resolve: async () => {
      calls += 1;
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });
  await optedIn('http://localhost:8080/');
  assert.equal(calls, 0);
});

test('non-network browser URLs are left to deterministic agent policy', async () => {
  let calls = 0;
  const guard = createNavigationEgressPreflight({
    route: () => 'unknown',
    allowPrivateNetwork: false,
    resolve: async () => {
      calls += 1;
      return [];
    },
  });
  await guard('about:blank');
  await guard('chrome://settings/privacy');
  await assert.rejects(guard('not a URL'), /destination URL is invalid/);
  assert.equal(calls, 0);
});

test('the per-profile registry stores only the DNS route needed by the guard', () => {
  const profileId = `egress-route-${Date.now()}`;
  try {
    assert.equal(resolveProfileNetworkRoute(profileId), undefined);
    provisionProfile(profileId, { networkRoute: 'direct' });
    assert.equal(resolveProfileNetworkRoute(profileId), 'direct');
    provisionProfile(profileId, { networkRoute: 'remote-proxy' });
    assert.equal(resolveProfileNetworkRoute(profileId), 'remote-proxy');
  } finally {
    forgetProfile(profileId);
  }
});
