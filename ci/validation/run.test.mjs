// Regression tests for the validation harness helpers (T-005).
//
// Run: `node --test ci/validation/`  (no browser needed — these exercise the pure decision logic).

import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateWebrtcLeakProtection } from './run.mjs';

// The bug this guards against: with `disable_non_proxied_udp` the protected run gathers 0 candidates,
// so suppressionLeakCount is trivially 0. Scoring that as a pass is vacuous — "no leak" is meaningless
// unless a CONTROL run (`default_public_interface_only` + STUN) first proves the probe CAN surface a
// public-IP srflx. Without a working control the gate must be SKIPPED (not-measured), never passed.

test('WebRTC gate is not-measured (null), never a vacuous pass, when the control never leaks', () => {
  // The vacuous scenario: no network/STUN, so the control gathered 0 public leaks. The pre-fix logic
  // (policyApplied && localLeakCount === 0 && suppressionLeakCount === 0) would return `true` here.
  assert.equal(
    evaluateWebrtcLeakProtection({
      policyApplied: true,
      localLeakCount: 0,
      controlLeakCount: 0, // control did not leak → probe unproven
      suppressionLeakCount: 0, // trivially zero under disable_non_proxied_udp
    }),
    null,
  );
});

test('WebRTC gate passes only once the control proves the probe can leak', () => {
  assert.equal(
    evaluateWebrtcLeakProtection({
      policyApplied: true,
      localLeakCount: 0,
      controlLeakCount: 1, // control leaked a public srflx → probe works
      suppressionLeakCount: 0, // protected run suppressed it
    }),
    true,
  );
});

test('WebRTC gate fails when the protected run leaks despite a working probe', () => {
  assert.equal(
    evaluateWebrtcLeakProtection({
      policyApplied: true,
      localLeakCount: 0,
      controlLeakCount: 1,
      suppressionLeakCount: 1, // protected run leaked the public IP → real failure
    }),
    false,
  );
});

test('WebRTC gate fails on a local (non-mDNS) host leak even with a working probe', () => {
  assert.equal(
    evaluateWebrtcLeakProtection({
      policyApplied: true,
      localLeakCount: 1, // a host candidate escaped as a raw IP (mDNS should have masked it)
      controlLeakCount: 1,
      suppressionLeakCount: 0,
    }),
    false,
  );
});

test('WebRTC gate fails when the leak-protection policy is not applied', () => {
  assert.equal(
    evaluateWebrtcLeakProtection({
      policyApplied: false,
      localLeakCount: 0,
      controlLeakCount: 1,
      suppressionLeakCount: 0,
    }),
    false,
  );
});
