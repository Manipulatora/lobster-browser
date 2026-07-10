# Anti-bot exam — "book the real exam"

> CreepJS and Sannysoft are fingerprint **audits**: internally-consistent surfaces. They do not answer
> the product question — *does a commercial anti-bot let this persona through?* This harness
> ([`ci/validation/antibot-exam.mjs`](../../ci/validation/antibot-exam.mjs)) drives a native Lobium
> persona against real detectors that return an actual verdict and records what happens. A recorded
> failure is worth more than another green CreepJS run.

## Run it

```bash
export LOBSTER_LOBIUM_BIN=/path/to/out/Lobium/chrome
node ci/validation/antibot-exam.mjs                 # built-in public detectors
LOBSTER_GPU=gpu node ci/validation/antibot-exam.mjs # on the real-GPU runner (defensible, not provisional)

# Point at real, authorized commercial-WAF targets (Cloudflare Bot Mgmt / DataDome / PerimeterX / …):
LOBSTER_EXAM_URLS="https://shop.example.com,https://app.example.com" node ci/validation/antibot-exam.mjs
```

Writes `ci/validation/reports/antibot-exam-latest.json` (+ timestamped copy). The report records
`gpuMode`, the observed renderer, and a `provisional` flag that is **true on a software renderer** — a
SwiftShader run is a real datapoint but not a defensible verdict; re-run on the real-GPU runner.

## Built-in targets

| Probe | Signal | Verdict meaning |
|---|---|---|
| `areyouheadless` (arh.antoinevastel.com) | headless yes/no | `fail` = detected headless |
| `deviceinfo-bot` (deviceandbrowserinfo.com) | full `{isBot, details:{…}}` JSON | `fail` = `isBot:true`; the `details` object names **which** signal fired |
| `fingerprintjs` (openfpcdn.io FPJS v4, in-page) | visitorId + confidence | `pass` = computed cleanly (identifier, not a bot verdict) |
| `creepjs` (abrahamjuliot.github.io) | lies count | authoritative version is the dedicated `creepjs-battle.mjs`; here it is a spot check |

Commercial WAFs only exist in front of a customer site, so they can't be tested in the abstract. For
`LOBSTER_EXAM_URLS` the harness classifies each response as `passed` / `challenged` / `blocked` using
generic vendor challenge markers (Cloudflare `cf-chl`/"just a moment", DataDome `captcha-delivery`,
PerimeterX `px-captcha`, Akamai `_abck`, Kasada `kpsdk`) plus 403/429/503 status.

The exam **records data**; it is not a red-build gate (a detector "fail" is a product signal to triage,
not a broken build). It exits non-zero only if every probe errored.

## First real finding (2026-07-10, provisional / SwiftShader)

The first live run flagged `deviceinfo-bot` as `isBot:true` — and the `details` showed the **only**
signal that fired was `hasWebdriverTrue` (`navigator.webdriver === true`). Notably
`isWebGLInconsistent:false` and `hasInconsistentGPUFeatures:false` — the claimed Intel UHD 630 over a
SwiftShader host was **not** caught. Root cause: the harness's minimal launcher omitted
`--disable-blink-features=AutomationControlled`. Switching the exam to the product's `buildLaunchOptions`
(the real launch path) flipped it to `isBot:false` with **zero** signals firing. Lesson: always drive the
exam through the product launch path; and re-run on real hardware before trusting the GPU-coherence
signals, which SwiftShader can't stress.
