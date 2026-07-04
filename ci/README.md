# CI & Validation

- [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml) — the pipeline: **web** (format /
  typecheck / build / test), **secret-scan** (gitleaks), **rust** (desktop build / test / fmt / clippy),
  **engine-launch** (installs a patched Chromium and runs the live-launch integration test), and
  **fingerprint-gate** (the anti-detect quality gate — **blocking**).
- [`validation/`](validation/) — the anti-detect quality gate. `thresholds.json` defines the objective
  pass/fail bar; `run.mjs` derives a fingerprint, launches it headful under Xvfb via the real launcher
  code path, drives it against a live detector (bot.sannysoft.com), and asserts our fingerprint applied
  with no automation tell. `--stub` verifies wiring where no browser is installed.
- [`validation/lobium-detect.mjs`](validation/lobium-detect.mjs) — the **native-engine** gate. Launches
  the REAL Lobium binary with a full coherent persona (native config channel for the deep surfaces +
  navigator hardware, PLUS the CDP JS-safe surfaces), connects over CDP, scores it against
  bot.sannysoft.com, AND directly asserts every native surface applied (WebGL unmasked vendor/renderer
  match the claim; per-profile canvas/audio farbling). Where `run.mjs` measures the interim engine's
  deep-surface gap, this proves Lobium closes it. Verified: 8/8 surfaces applied, sannysoft 0-failed,
  per-profile-diverse GPU/canvas/audio across seeds.

Run locally:

```bash
npx tsc -b packages/shared-types packages/proxy packages/fingerprint packages/engine-runner
xvfb-run -a node ci/validation/run.mjs      # real interim-engine gate (needs patchright's Chromium)
node ci/validation/run.mjs --stub           # wiring-only

# native-engine gate — needs a built Lobium binary (out/Lobium/chrome) + network:
LOBSTER_LOBIUM_BIN=/path/to/out/Lobium/chrome node ci/validation/lobium-detect.mjs [seed]
```

Per [`../docs/agent-protocol.md`](../docs/agent-protocol.md) §4, fingerprint-surface/engine changes
must keep this gate green.
