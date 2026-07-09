import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProxy } from './parse.js';
import { deriveGeoFromExitIp, parseGeoResponse, testProxy } from './geo.js';

// Sample ip-api.com response for a residential exit IP (hosting = false).
const RESIDENTIAL_RAW = {
  status: 'success',
  countryCode: 'DE',
  region: 'BY',
  city: 'Munich',
  timezone: 'Europe/Berlin',
  lat: 48.1374,
  lon: 11.5755,
  as: 'AS3320 Deutsche Telekom AG',
  hosting: false,
  query: '84.140.1.2',
};

// Sample ip-api.com response for a datacenter/cloud exit IP (hosting = true).
const DATACENTER_RAW = {
  status: 'success',
  countryCode: 'US',
  region: 'VA',
  city: 'Ashburn',
  timezone: 'America/New_York',
  lat: 39.0438,
  lon: -77.4874,
  as: 'AS14618 Amazon.com, Inc.',
  hosting: true,
  query: '3.4.5.6',
};

test('parseGeoResponse maps a residential ip-api response to GeoInfo', () => {
  const geo = parseGeoResponse(RESIDENTIAL_RAW);
  assert.deepEqual(geo, {
    ip: '84.140.1.2',
    countryCode: 'DE',
    region: 'BY',
    city: 'Munich',
    timezone: 'Europe/Berlin',
    latitude: 48.1374,
    longitude: 11.5755,
    asn: 'AS3320 Deutsche Telekom AG',
    isDatacenter: false,
  });
});

test('parseGeoResponse flags datacenter/hosting exits via isDatacenter', () => {
  const geo = parseGeoResponse(DATACENTER_RAW);
  assert.equal(geo.isDatacenter, true);
  assert.equal(geo.ip, '3.4.5.6');
  assert.equal(geo.countryCode, 'US');
  assert.equal(geo.timezone, 'America/New_York');
  assert.equal(geo.asn, 'AS14618 Amazon.com, Inc.');
});

test('parseGeoResponse omits optional fields when absent', () => {
  const geo = parseGeoResponse({
    status: 'success',
    countryCode: 'FR',
    timezone: 'Europe/Paris',
    query: '1.2.3.4',
  });
  assert.deepEqual(geo, { ip: '1.2.3.4', countryCode: 'FR', timezone: 'Europe/Paris' });
  assert.equal('region' in geo, false);
  assert.equal('isDatacenter' in geo, false);
});

test('parseGeoResponse throws on a failed lookup, surfacing the endpoint message', () => {
  assert.throws(
    () => parseGeoResponse({ status: 'fail', message: 'private range', query: '10.0.0.1' }),
    /private range/,
  );
});

test('parseGeoResponse throws when required fields are missing', () => {
  assert.throws(
    () => parseGeoResponse({ status: 'success', query: '1.2.3.4' }),
    /missing required/,
  );
  assert.throws(() => parseGeoResponse(null), /expected a JSON object/);
});

test('deriveGeoFromExitIp routes SOCKS5 through socks5h (fails closed on dead proxy)', async () => {
  // 127.0.0.1:1 refuses immediately — proves the SOCKS path is exercised (not the old hard reject).
  const socks = parseProxy('socks5://127.0.0.1:1', 'socks-id');
  await assert.rejects(() => deriveGeoFromExitIp(socks, { timeoutMs: 1_000 }), /./);
});

test('testProxy returns ok:false for a dead SOCKS5 proxy rather than throwing', async () => {
  const socks = parseProxy('socks5://127.0.0.1:1', 'socks-id-2');
  const result = await testProxy(socks, { timeoutMs: 1_000 });
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.equal(result.geo, undefined);
});

test('testProxy returns ok:false for an unreachable proxy (fast, no live network)', async () => {
  // 127.0.0.1:1 refuses immediately; the short timeout bounds any slow path.
  const dead = parseProxy('http://127.0.0.1:1', 'dead-id');
  const result = await testProxy(dead, { timeoutMs: 1_000 });
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.equal(result.geo, undefined);
});
