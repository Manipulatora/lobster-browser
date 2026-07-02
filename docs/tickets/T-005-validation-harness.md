# T-005 — Validation harness: host CreepJS/Sannysoft + score scraper

- **Pillar/Track:** E · QA / Anti-Detect Validation
- **Assignee:** Claude
- **Status:** ready

## Goal

Stand up the objective anti-detect quality gate: self-host the detector pages, launch a profile
against them, scrape the scores, and expose a pass/fail result that CI can enforce from Day 4.

## Spec

- Under `ci/validation/`, vendor/serve **CreepJS** and **bot.sannysoft** locally (static host on a
  loopback port). Add Pixelscan/Iphey/browserleaks as external checks behind a flag.
- `ci/validation/run.mjs`: given a `profileId` (or an ephemeral test profile), launch it via the
  engine-runner, navigate to each detector, scrape: CreepJS trust score + "lies", Sannysoft pass/fail
  matrix, and WebRTC leak (ICE IP vs proxy IP).
- Emit a JSON report + a boolean gate result against thresholds defined in `ci/validation/thresholds.json`.

## Files to touch

- `ci/validation/*` (new), `ci/README.md`.

## Acceptance criteria

- `node ci/validation/run.mjs --engine chromium` (or `--engine lobium`) produces a JSON report with a
  CreepJS trust score and a Sannysoft matrix, and a `pass`/`fail` verdict.
- Runs headful under Xvfb on Linux CI with a real GPU where available (document the SwiftShader caveat).

## Test requirements

- A smoke test that the harness boots the detector host and returns a structured report (can run
  against a stub engine in CI if a real GPU is unavailable).
