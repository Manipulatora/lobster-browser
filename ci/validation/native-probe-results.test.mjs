import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCreepjsBattle } from './creepjs-battle.mjs';
import { summarizeDeepProbeResults } from './deep-probe-50.mjs';

test('deep probe is green only when every persona produced an object readout', () => {
  assert.deepEqual(
    summarizeDeepProbeResults([
      {
        observed: {
          navigator: { userAgent: 'ua-a', platform: 'Win32' },
          screen: { width: 1920, height: 1080 },
        },
      },
      {
        observed: {
          navigator: { userAgent: 'ua-b', platform: 'Linux x86_64' },
          screen: { width: 1366, height: 768 },
        },
      },
    ]),
    { passed: 2, failed: 0, verdict: 'pass' },
  );
  assert.deepEqual(
    summarizeDeepProbeResults([
      {
        observed: {
          navigator: { userAgent: 'ua-a', platform: 'Win32' },
          screen: { width: 1920, height: 1080 },
        },
      },
      { observed: null },
      { error: 'engine exited' },
    ]),
    { passed: 1, failed: 2, verdict: 'fail' },
  );
});

test('deep probe rejects the fp-probe rejection payload and incomplete readouts', () => {
  assert.deepEqual(summarizeDeepProbeResults([{ observed: { error: 'probe rejected' } }]), {
    passed: 0,
    failed: 1,
    verdict: 'fail',
  });
  assert.deepEqual(summarizeDeepProbeResults([{ observed: { navigator: {}, screen: {} } }]), {
    passed: 0,
    failed: 1,
    verdict: 'fail',
  });
});

test('deep probe classifies zero evidence as blocked', () => {
  assert.deepEqual(summarizeDeepProbeResults([]), {
    passed: 0,
    failed: 0,
    verdict: 'blocked',
  });
});

test('CreepJS incomplete evidence blocks and measured failures take precedence', () => {
  assert.deepEqual(classifyCreepjsBattle({ pass: 120, fail: 0, unavailable: 0, error: 0 }), {
    verdict: 'pass',
    exitCode: 0,
  });
  assert.deepEqual(classifyCreepjsBattle({ pass: 119, fail: 0, unavailable: 1, error: 0 }), {
    verdict: 'blocked',
    exitCode: 2,
  });
  assert.deepEqual(classifyCreepjsBattle({ pass: 0, fail: 0, unavailable: 0, error: 0 }), {
    verdict: 'blocked',
    exitCode: 2,
  });
  assert.deepEqual(classifyCreepjsBattle({ pass: 118, fail: 1, unavailable: 1, error: 0 }), {
    verdict: 'fail',
    exitCode: 1,
  });
});
