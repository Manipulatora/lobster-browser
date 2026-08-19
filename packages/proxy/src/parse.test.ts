import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatProxyUrl,
  parseProxy,
  parseProxyList,
  toEnginePlaywrightProxy,
  validateProxyConfig,
  validateProxyRotationUrl,
} from './parse.js';

test('parses URL form with credentials', () => {
  const p = parseProxy('socks5://user:pass@host.example:1080', 'id1');
  assert.equal(p.type, 'socks5');
  assert.equal(p.host, 'host.example');
  assert.equal(p.port, 1080);
  assert.equal(p.username, 'user');
  assert.equal(p.password, 'pass');
  assert.equal(p.id, 'id1');
});

test('rotation URLs are explicit absolute HTTP(S) endpoints', () => {
  assert.equal(
    validateProxyRotationUrl('https://provider.example/rotate?token=secret'),
    'https://provider.example/rotate?token=secret',
  );
  assert.throws(() => validateProxyRotationUrl('javascript:alert(1)'), /HTTP or HTTPS/);
  assert.throws(() => validateProxyRotationUrl('/rotate'), /absolute URL/);
  assert.throws(
    () => validateProxyRotationUrl('https://provider.example/rotate#token'),
    /fragment/,
  );
});

test('parses colon form host:port:user:pass', () => {
  const p = parseProxy('1.2.3.4:8080:bob:secret', 'id2');
  assert.equal(p.type, 'http');
  assert.equal(p.host, '1.2.3.4');
  assert.equal(p.port, 8080);
  assert.equal(p.username, 'bob');
  assert.equal(p.password, 'secret');
});

test('parses host:port without credentials', () => {
  const p = parseProxy('1.2.3.4:3128', 'id3');
  assert.equal(p.host, '1.2.3.4');
  assert.equal(p.port, 3128);
  assert.equal(p.username, undefined);
  assert.equal(p.password, undefined);
});

test('throws on invalid port and empty input', () => {
  assert.throws(() => parseProxy('host:notaport'));
  assert.throws(() => parseProxy('http://host:0'));
  assert.throws(() => parseProxy('host:65536'));
  assert.throws(() => parseProxy(''));
});

test('rejects unknown URL schemes instead of silently reinterpreting them as HTTP', () => {
  assert.throws(() => parseProxy('ftp://host.example:21'), /unsupported proxy scheme/);
  assert.throws(() => parseProxy('ssh://host.example:22'), /unsupported proxy scheme/);
  assert.throws(() => parseProxy('http://host.example:8080/unexpected'), /must not contain a path/);
});

test('keeps a literal percent in credentials instead of throwing on decode', () => {
  const p = parseProxy('http://user:pa%ss@host.example:8080', 'id7');
  assert.equal(p.host, 'host.example');
  assert.equal(p.port, 8080);
  assert.equal(p.username, 'user');
  assert.equal(p.password, 'pa%ss');
});

test('accepts the scheme default port (url.port is empty for http:80/https:443/socks:default)', () => {
  assert.equal(parseProxy('http://host.example:80', 'id8').port, 80);
  assert.equal(parseProxy('https://host.example:443', 'id9').port, 443);
  assert.equal(parseProxy('socks5://host.example', 'id10').port, 1080);
});

test('formatProxyUrl round-trips a URL-form proxy', () => {
  const p = parseProxy('http://u:p@h:8000', 'id4');
  assert.equal(formatProxyUrl(p), 'http://u:p@h:8000');
});

test('colon form preserves colons in passwords and supports bracketed IPv6', () => {
  const credentialed = parseProxy('host.example:8080:user:pa:ss:word', 'id-colon');
  assert.equal(credentialed.username, 'user');
  assert.equal(credentialed.password, 'pa:ss:word');

  const ipv6 = parseProxy('[2001:db8::1]:1080', 'id-ipv6');
  assert.equal(ipv6.host, '[2001:db8::1]');
  assert.equal(formatProxyUrl(ipv6), 'http://[2001:db8::1]:1080');
});

test('parseProxy mints an id when the caller does not supply one', () => {
  const p = parseProxy('1.2.3.4:8080');
  assert.match(p.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(parseProxy('1.2.3.4:8080').id, p.id);
});

test('a pasted list imports the good lines and names the bad ones', () => {
  const results = parseProxyList(
    [
      '# vendor export',
      '1.2.3.4:8080:bob:secret',
      '',
      'socks5://user:pass@host.example:1080',
      'not-a-proxy',
      '  5.6.7.8:3128  ',
    ].join('\n'),
  );
  assert.equal(results.length, 4);
  assert.deepEqual(
    results.map((r) => [r.line, r.ok]),
    [
      [2, true],
      [4, true],
      [5, false],
      [6, true],
    ],
  );
  const [first] = results;
  assert.ok(first?.ok && first.config.username === 'bob');
  const failed = results.find((r) => !r.ok);
  assert.ok(failed && !failed.ok && !failed.error.startsWith('parseProxy:'));
  const trimmed = results[3];
  assert.ok(trimmed?.ok && trimmed.config.host === '5.6.7.8');
});

test('every line of a list gets its own proxy id', () => {
  const results = parseProxyList('1.2.3.4:8080\n1.2.3.4:8080');
  const ids = results.filter((r) => r.ok).map((r) => (r.ok ? r.config.id : ''));
  assert.equal(new Set(ids).size, 2);
});

test('runtime validation catches malformed IPC/database ProxyConfig values', () => {
  assert.deepEqual(
    validateProxyConfig({ id: 'bad', type: 'http', host: 'proxy.test', port: 70_000 }),
    ['proxy port must be an integer in 1-65535'],
  );
  assert.match(
    validateProxyConfig({
      id: 'bad-auth',
      type: 'socks5',
      host: 'proxy.test',
      port: 1080,
      password: 'secret',
    }).join('; '),
    /without a username/,
  );
  assert.throws(
    () =>
      toEnginePlaywrightProxy({
        id: 'bad-type',
        type: 'ftp' as never,
        host: 'proxy.test',
        port: 21,
      }),
    /invalid proxy config/,
  );
});

test('toEnginePlaywrightProxy shapes server + auth for Playwright/patchright', () => {
  const p = parseProxy('socks5://u:p@h:1080', 'id5');
  const pw = toEnginePlaywrightProxy(p);
  assert.equal(pw.server, 'socks5://h:1080');
  assert.equal(pw.username, 'u');
  assert.equal(pw.password, 'p');

  const noauth = toEnginePlaywrightProxy(parseProxy('http://h:3128', 'id6'));
  assert.equal(noauth.username, undefined);
});
