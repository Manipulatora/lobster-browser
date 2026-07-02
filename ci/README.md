# CI & Validation

- [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml) — the pipeline: **web** (format /
  typecheck / build / test), **secret-scan** (gitleaks), **rust** (desktop build / test / fmt / clippy),
  **engine-launch** (installs a patched Chromium and runs the live-launch integration test), and
  **fingerprint-gate** (the anti-detect quality gate — **blocking**).
- [`validation/`](validation/) — the anti-detect quality gate. `thresholds.json` defines the objective
  pass/fail bar; `run.mjs` derives a fingerprint, launches it headful under Xvfb via the real launcher
  code path, drives it against a live detector (bot.sannysoft.com), and asserts our fingerprint applied
  with no automation tell. `--stub` verifies wiring where no browser is installed.

Run locally:

```bash
npx tsc -b packages/shared-types packages/proxy packages/fingerprint packages/engine-runner
xvfb-run -a node ci/validation/run.mjs      # real (needs patchright's Chromium)
node ci/validation/run.mjs --stub           # wiring-only
```

Per [`../docs/agent-protocol.md`](../docs/agent-protocol.md) §4, fingerprint-surface/engine changes
must keep this gate green.
