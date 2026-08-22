# Linux Release Engineering Plan — 2026-08-21

Scope: rebuild the production surface from a clean slate on `158.220.91.217` (lobrowser.com),
then qualify it across 13 domains from both a customer's and a tester's perspective.

## Ground truth established before starting

| Fact | Evidence |
| --- | --- |
| This box IS production | `lobrowser.com` + `api.lobrowser.com` -> `158.220.91.217` |
| `api.lobrowser.com` is DOWN | HTTP 502; nothing on :8080; `/opt/lobster/backend` absent |
| The NestJS API was never deployed | no unit, no build, no `/etc/lobster/backend.env` |
| `lobster-backend.service` is a FOREIGN service | `Description=Lobster backend (Phone/Twilio broker)`, crash-looping `status=1` every ~2s |
| Production DB is effectively empty | 1 user, 1 team, 1 wallet; 0 profiles/vault_keys/deposits/transactions/subscriptions |
| Engine is current | `Lobium 152.0.7977.42`, 18 capabilities, product-e2e PASS |

## Owner decisions (2026-08-21)

1. Remove the Phone/Twilio backend **entirely, no trace**; deploy the real API fresh.
2. Use **local substitutes** for SMTP / NOWPayments / OpenRouter.
3. Benchmark on SwiftShader, **labelled non-release**; stress **the production endpoint**.

## Phases

### P0 - Preserve
Back up the Postgres DB and the nginx/systemd state before any destructive step. Everything below
is reversible from this backup.

### P1 - Engine correctness (long pole, runs in background)
Fix `canvas-getpixelmods-toblob`. Hypothesis: `ChannelKey` is a pure function of ABSOLUTE pixel
coords and is therefore path-independent, but `IsFlatRun` is neighbour-dependent and its contract
says "a null neighbour is outside the context, which at the canvas edge is also outside the canvas"
- true for a whole-canvas `toBlob` pass, false for a `getImageData` SUB-RECT, whose edge pixels have
null neighbours that are NOT canvas edges. Rebuild (~45 min warm) and re-score the oracles.

### P2 - Infrastructure teardown and rebuild
Purge the Twilio broker (stop, disable, mask-free removal of unit + drop-ins + its install dir).
Drop and recreate the `lobster` database, apply the Prisma migration chain fresh.
Generate real secrets (`JWT_SECRET`, `VAULT_MASTER_KEY`, `BILLING_ADMIN_TOKEN`).
Stand up a local SMTP catcher so verification codes are readable and signup can complete.
Build + deploy the API, install a clean unit, repoint nginx at `api.lobrowser.com`, prove
`/health/ready`.

### P3 - Desktop reinstall
Uninstall the current install, install the freshly built `.deb`, verify the engine it resolves.

### P4 - Qualification, 13 domains
Run each domain as a customer would, then adversarially as a tester. Every result must be one of
PASS / FAIL / BLOCKED, and BLOCKED must name what was missing. No domain may be reported green on
the strength of a test that did not actually execute.

1. desktop installation           8. profile sync (cookies/storage/extensions)
2. sign up / auth flow            9. profile export/import to file
3. purchasing / billing          10. billing gaps and money leaks
4. profile setup / launch        11. frontend UI/UX, icons, logos
5. anti-detect benchmarking      12. engine performance
6. Lobee agent e2e               13. server load / stress
7. backend e2e

## Reporting rule
A software gate passing is not evidence a customer can do the thing. Each domain reports what was
actually exercised end to end, and names what was simulated or substituted.
