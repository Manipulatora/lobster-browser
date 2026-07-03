import assert from 'node:assert/strict';
import test from 'node:test';
import { formatProxyUrl, parseProxy, toEnginePlaywrightProxy } from './parse.js';

test('parses URL form with credentials', () => {
  const p = parseProxy('socks5://user:pass@host.example:1080', 'id1');
  assert.equal(p.type, 'socks5');
  assert.equal(p.host, 'host.example');
  assert.equal(p.port, 1080);
  assert.equal(p.username, 'user');
  assert.equal(p.password, 'pass');
  assert.equal(p.id, 'id1');
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
  assert.throws(() => parseProxy(''));
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

test('toEnginePlaywrightProxy shapes server + auth for Playwright/patchright', () => {
  const p = parseProxy('socks5://u:p@h:1080', 'id5');
  const pw = toEnginePlaywrightProxy(p);
  assert.equal(pw.server, 'socks5://h:1080');
  assert.equal(pw.username, 'u');
  assert.equal(pw.password, 'p');

  const noauth = toEnginePlaywrightProxy(parseProxy('http://h:3128', 'id6'));
  assert.equal(noauth.username, undefined);
});
