# T-023 — Official SDK examples + connect docs

**Pillar:** 3 · Local Automation API · **Assignee:** Codex (workflow agent) + Claude · **Status:** done · **Day:** 6 (Track D)

Turn the `@lobster/local-api-sdk` stubs into production-quality client examples with runnable connect recipes.

## What shipped — `packages/local-api-sdk/`

- **JS client** (`js/index.js`, ESM, `@ts-check`, zero deps): one canonical base URL, `Authorization: Bearer`
  on every route except `/health`, per-request **timeout** (`AbortController`), **retry** (2×, exp backoff) on
  transport/timeout only — never on a non-zero envelope, envelope unwrapping, all endpoints +
  `connectPlaywright()`. Throws typed `LobsterApiError` (deterministic) vs `LobsterNetworkError` (transport);
  injectable `fetch` for testing. **8-test** `node:test` suite (auth header, endpoints, no-retry-on-envelope,
  retry-then-succeed).
- **Python client** (`python/lobster_client.py`, stdlib-only): `TypedDict` payloads, `@dataclass` client,
  context manager, timeout, retry (broadened to catch `ConnectionError`/`RemoteDisconnected` — a real bug the
  agent's smoke test caught), `HTTPError` bodies read so the server `msg` surfaces.
- **README**: quickstart, endpoint table, error model, and RUNNABLE connect recipes for **Selenium (Python)**,
  **Playwright (Python + JS)**, and **Puppeteer (JS)** — mirroring the AdsPower/Octo contract.

## Verification

- `cd packages/local-api-sdk/js && node --test` → 8/8; Python parses + smoke-tested; matches
  [`docs/contracts/local-automation-api.md`](../contracts/local-automation-api.md) exactly.

## Follow-ups

- A **typed C# client** + the **MCP server** wrapper (`docs/specs/api-reference.md` §4–§5).
- Wire the desktop local API's Bearer check to the backend `verify()` (T-021) so SDK keys authenticate.
