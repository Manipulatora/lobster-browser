import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  domainInFamily,
  registrableDomain,
  resolveSiteFamily,
  siteNamedIn,
} from './site-families.js';

test('registrableDomain strips hosts and leading dots down to the site', () => {
  assert.equal(registrableDomain('login.live.com'), 'live.com');
  assert.equal(registrableDomain('.outlook.com'), 'outlook.com');
  assert.equal(registrableDomain('www.amazon.co.uk'), 'amazon.co.uk');
  assert.equal(registrableDomain('OUTLOOK.LIVE.COM'), 'live.com');
});

test('outlook.com resolves to the domains Microsoft actually keeps the session on', () => {
  const family = resolveSiteFamily('outlook.com', [
    '.outlook.com',
    'login.live.com',
    'login.microsoftonline.com',
    '.office.com',
    '.example.test',
  ]);
  for (const member of ['outlook.com', 'live.com', 'microsoftonline.com', 'office.com']) {
    assert.ok(family.includes(member), `${member} should be in the outlook family`);
  }
  assert.ok(!family.includes('example.test'), 'unrelated domains stay out');
  assert.ok(domainInFamily('login.live.com', family));
  assert.ok(!domainInFamily('example.test', family));
});

test('a site the table does not know still owns its own subdomains and nothing else', () => {
  const family = resolveSiteFamily('shop.example.test', [
    '.example.test',
    'cdn.example.test',
    '.other.test',
  ]);
  assert.deepEqual([...family].sort(), ['example.test']);
  assert.ok(domainInFamily('cdn.example.test', family));
  assert.ok(!domainInFamily('other.test', family));
});

test('siteNamedIn finds the site a request is about, and nothing for a site-less one', () => {
  assert.equal(siteNamedIn('remove all cookies of outlook.com in this browser'), 'outlook.com');
  assert.equal(siteNamedIn('log me out of my Outlook'), 'outlook.com');
  assert.equal(siteNamedIn('clear the cookies for mail.example.co.uk please'), 'example.co.uk');
  assert.equal(siteNamedIn('reset gmail'), 'google.com');
  assert.equal(siteNamedIn('clear all cookies'), undefined);
  assert.equal(siteNamedIn('log me out everywhere'), undefined);
});
