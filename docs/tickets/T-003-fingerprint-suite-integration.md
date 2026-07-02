# T-003 — Fingerprint: integrate Apify fingerprint-suite behind `deriveFingerprint`

- **Pillar/Track:** Fingerprint
- **Assignee:** Codex
- **Status:** ready

## Goal

Swap the Day 0 built-in device pools for Apify **fingerprint-suite** (`fingerprint-generator`) so
profiles draw from statistically-realistic, internally-coherent real-device distributions — while
keeping the existing `@lobster/fingerprint` public API and determinism.

## Spec

- Add `fingerprint-generator` (+ `header-generator` if needed) to `packages/fingerprint`.
- Keep `deriveFingerprint(seed, { os, engine, arch })` deterministic: feed the seed-derived PRNG so
  the same seed still yields the same fingerprint (map the generator's randomness source to our seed,
  or select deterministically from a generated candidate set).
- Preserve the `Fingerprint` shape from `@lobster/shared-types`. Continue to leave locale/timezone as
  defaults overwritten by `applyGeoToFingerprint`.
- Keep `validateFingerprintCoherence` passing for all generated fingerprints; extend it with any new
  coherence checks the richer data enables (e.g. WebGL vendor vs OS).

## Files to touch

- `packages/fingerprint/src/derive.ts`, `src/pools.ts` (retire or keep as fallback), `package.json`.

## Acceptance criteria

- `deriveFingerprint` is still deterministic (same seed → identical output).
- Generated fingerprints pass `validateFingerprintCoherence` with zero issues across all OS/engine combos.
- No change required in `engine-runner` call sites (API stable).

## Test requirements

- Determinism test (100 seeds, re-derive, deep-equal).
- Coherence test across `{windows,macos,linux} ×` Chrome-family engines (`{chromium, lobium}`) — no
  Firefox surfaces.
