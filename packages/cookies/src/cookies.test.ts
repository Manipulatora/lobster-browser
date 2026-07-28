import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseJson,
  parseNetscape,
  serializeJson,
  serializeNetscape,
  validateCookie,
  type Cookie,
} from './index.js';

/** A mix that exercises persistent, session, secure, HttpOnly, subdomain, and sameSite cases. */
const sampleCookies: Cookie[] = [
  {
    name: 'session_id',
    value: 'abc123',
    domain: '.example.com',
    path: '/',
    expires: 1893456000,
    httpOnly: true,
    secure: true,
  },
  {
    name: 'theme',
    value: 'dark',
    domain: 'app.example.com',
    path: '/settings',
    // session cookie: no `expires`
    httpOnly: false,
    secure: false,
  },
];

test('round-trip Cookie -> Netscape -> Cookie is identity', () => {
  const restored = parseNetscape(serializeNetscape(sampleCookies));
  assert.deepEqual(restored, sampleCookies);
});

test('round-trip Cookie -> JSON -> Cookie is identity (incl. sameSite)', () => {
  const withSameSite: Cookie[] = [
    ...sampleCookies,
    {
      name: 'csrf',
      value: 'tok',
      domain: 'example.com',
      path: '/',
      expires: 1893456000,
      httpOnly: false,
      secure: true,
      sameSite: 'Strict',
    },
  ];
  const restored = parseJson(serializeJson(withSameSite));
  assert.deepEqual(restored, withSameSite);
});

test('parseNetscape parses a realistic multi-line cookies.txt', () => {
  const text = [
    '# Netscape HTTP Cookie File',
    '# a human-written comment that must be ignored',
    '',
    '.example.com\tTRUE\t/\tTRUE\t1893456000\tsession_id\tabc123',
    '#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1893456000\tauth\tsecret',
    'app.example.com\tFALSE\t/settings\tFALSE\t0\ttheme\tdark',
  ].join('\n');

  const cookies = parseNetscape(text);
  assert.deepEqual(cookies, [
    {
      name: 'session_id',
      value: 'abc123',
      domain: '.example.com',
      path: '/',
      expires: 1893456000,
      httpOnly: false,
      secure: true,
    },
    {
      name: 'auth',
      value: 'secret',
      domain: '.example.com',
      path: '/',
      expires: 1893456000,
      httpOnly: true,
      secure: true,
    },
    {
      name: 'theme',
      value: 'dark',
      domain: 'app.example.com',
      path: '/settings',
      // expiry 0 => session, so no `expires`
      httpOnly: false,
      secure: false,
    },
  ]);
});

test('Netscape session cookie (expiry 0) has no expires; serialize emits 0', () => {
  const [themed] = parseNetscape('app.example.com\tFALSE\t/\tFALSE\t0\ttheme\tdark');
  assert.ok(themed);
  assert.equal('expires' in themed, false);

  const serialized = serializeNetscape([themed]);
  // The single data line ends with the seven columns; expiry column is 0.
  const dataLine = serialized.split('\n').find((l) => l.includes('theme'));
  assert.ok(dataLine);
  assert.equal(dataLine.split('\t')[4], '0');
});

test('JSON session cookie uses Playwright -1 sentinel on the wire', () => {
  const [session] = parseJson(
    JSON.stringify([
      {
        name: 's',
        value: 'v',
        domain: 'example.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
      },
    ]),
  );
  assert.ok(session);
  assert.equal('expires' in session, false);
  assert.ok(serializeJson([session]).includes('"expires": -1'));
});

test('parseNetscape skips malformed lines (wrong field count, bad expiry)', () => {
  const text = [
    'example.com\tFALSE\t/\tFALSE', // too few columns
    'example.com\tFALSE\t/\tFALSE\tnot-a-number\tname\tvalue', // non-numeric expiry
    'example.com\tFALSE\t/\tFALSE\t123\tgood\tv\textra', // too many columns
    'example.com\tFALSE\t/\tFALSE\t1893456000\tkeep\tme', // the one valid line
  ].join('\n');

  const cookies = parseNetscape(text);
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0]?.name, 'keep');
});

test('Netscape includeSubdomains column is preserved even when the source omits a leading dot', () => {
  const [cookie] = parseNetscape('example.com\tTRUE\t/\tTRUE\t1893456000\tsid\tabc');
  assert.equal(cookie?.domain, '.example.com');
  assert.match(serializeNetscape([cookie!]), /^\.example\.com\tTRUE/m);
});

test('cookie validation enforces modern SameSite and security-prefix invariants', () => {
  assert.deepEqual(
    validateCookie({
      name: '__Host-session',
      value: 'v',
      domain: 'example.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    }),
    [],
  );
  assert.match(
    validateCookie({
      name: '__Host-session',
      value: 'v',
      domain: '.example.com',
      path: '/app',
      httpOnly: true,
      secure: false,
      sameSite: 'None',
    }).join('; '),
    /SameSite=None requires Secure.*__Host- cookies require Secure.*path=\/.*host-only/,
  );
});

test('parseJson skips malformed entries and defaults path to /', () => {
  const text = JSON.stringify([
    'not-an-object',
    { name: 'x' }, // missing value/domain
    { name: 'ok', value: 'v', domain: 'example.com' }, // no path -> '/'
  ]);
  const cookies = parseJson(text);
  assert.equal(cookies.length, 1);
  assert.deepEqual(cookies[0], {
    name: 'ok',
    value: 'v',
    domain: 'example.com',
    path: '/',
    httpOnly: false,
    secure: false,
  });
});

test('parseJson throws on non-array top-level JSON', () => {
  assert.throws(() => parseJson('{"name":"x"}'), /top-level JSON array/);
});
