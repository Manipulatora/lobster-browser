# CI & Validation

- [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml) — the pipeline: **web** (format /
  typecheck / build / test), **secret-scan** (gitleaks), **rust** (desktop build / test / fmt / clippy),
  **engine-launch** (direct native Lobium launch when a binary is provisioned; Patchright jobs are
  internal compatibility harnesses), and **fingerprint-gate** (the anti-detect quality gate — **blocking**
  once a real-GPU Lobium runner is available).
- [`validation/`](validation/) — the anti-detect quality gate. `thresholds.json` defines the objective
  pass/fail bar; `run.mjs` derives a fingerprint, launches it headful under Xvfb via the real launcher
  code path, drives it against a live detector (bot.sannysoft.com), and asserts our fingerprint applied
  with no automation tell. `--stub` verifies wiring where no browser is installed.
- [`validation/lobium-detect.mjs`](validation/lobium-detect.mjs) — the **native-engine** gate script.
  Launches a real Lobium binary with a coherent persona through the native config channel, connects over
  CDP for control/measurement, scores bot.sannysoft.com, and directly asserts native surfaces. This is
  **not yet a blocking CI job** and currently runs in the dev/SwiftShader mode unless RG-1 changes the
  launch flags/environment.

Run locally:

```bash
npx tsc -b packages/shared-types packages/proxy packages/fingerprint packages/engine-runner
xvfb-run -a node ci/validation/run.mjs      # internal harness gate, not production stealth
node ci/validation/run.mjs --stub           # wiring-only

# native-engine gate — needs a built Lobium binary (out/Lobium/chrome) + network.
# Today this is a local/dev proof; RG-1 promotes it to real-GPU proof. The script resolves
# LOBSTER_LOBIUM_BIN, LOBSTER_LOBIUM_DIR, common dev layouts such as ~/lobium-build/src/out/Lobium/chrome,
# and future packaged engine-resource dirs.
node ci/validation/lobium-detect.mjs [seed]
```

Per [`../docs/agent-protocol.md`](../docs/agent-protocol.md) §4, fingerprint-surface/engine changes
must keep this gate green.
