# CI & Validation

- [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml) — the pipeline: **web** (format /
  typecheck / build / test), **secret-scan** (gitleaks), **rust** (desktop fmt/clippy — non-blocking
  until T-001), and **fingerprint-gate** (non-blocking until T-005).
- [`validation/`](validation/) — the anti-detect quality gate. `thresholds.json` defines the
  objective pass/fail bar; `run.mjs` runs it (`--stub` for wiring, real detectors land in T-005).

The fingerprint gate becomes **blocking** once T-005 lands, per
[`../docs/agent-protocol.md`](../docs/agent-protocol.md) §4.
