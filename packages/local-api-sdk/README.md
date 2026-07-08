# @lobster/local-api-sdk

Zero-dependency client examples for the Lobster Browser **[Local Automation API](../../docs/contracts/local-automation-api.md)** —
the loopback HTTP server the desktop agent exposes (default `http://127.0.0.1:53211`). It deliberately
mirrors the proven **AdsPower/Octo** contract, so an existing integration ports over with near-zero
friction: `start` a profile, then drive it with your framework of choice via the returned endpoints.

- [`js/`](js/) — ESM JavaScript client (`LobsterClient`). Global `fetch`, no npm deps.
- [`python/`](python/) — stdlib-only Python client (`LobsterClient`).

Both add a per-request **timeout**, **retry** transient network failures (never an error envelope),
and unwrap the `{ code, data, msg }` envelope. `start()` returns **both** a CDP `ws://` (Playwright /
Puppeteer) **and** a Selenium `debuggerAddress`.

## Endpoints

| Method | Path | SDK call | Returns |
|---|---|---|---|
| `GET`  | `/health` | `health()` | `{ status: "ok" }` (no auth) |
| `POST` | `/profile/start` | `start(id, { headless, password })` | `{ profileId, ws, debuggerAddress, webDriver?, pid }` |
| `POST` | `/profile/stop` | `stop(id)` | `{ profileId, stopped }` |
| `GET`  | `/profile/list` | `list()` | `[{ profileId, name, running }]` |
| `GET`  | `/profile/status` | `status(id)` | `{ profileId, running, ws?, debuggerAddress? }` |
| `POST` | `/proxy/test` | `testProxy(config, { id })` / `test_proxy(config, id=...)` | `{ ok, latencyMs?, geo?, error? }` |

Every call except `/health` needs the Bearer API key (minted in the desktop UI / backend, see
[`api-keys`](../../apps/backend/src/api-keys)).

## Errors

Methods return the unwrapped `data` and throw a typed error otherwise:

- **`LobsterApiError`** — the API reported failure: a non-zero envelope `code` or a non-2xx HTTP
  status. Carries the `endpoint` and server `msg`. **Never retried** (a deterministic failure).
- **`LobsterNetworkError`** — the request never completed (connection refused/reset or timeout) after
  the retries were exhausted. Carries the `endpoint` and attempt count.

In Python both derive from `LobsterError`, so `except LobsterError` catches either. Both are
exported from the JS module and importable from `lobster_client` in Python.

## Quickstart

```js
// JavaScript (Node ≥ 18)
import { LobsterClient } from '@lobster/local-api-sdk';
const client = new LobsterClient({ apiKey: 'lb_live_…' });
const { ws, debuggerAddress } = await client.start('my-profile-id');
// Protected profile: await client.start('my-profile-id', { password: 'profile-password' });
// …drive the browser…
await client.stop('my-profile-id');
```

```python
# Python (stdlib only)
from lobster_client import LobsterClient
with LobsterClient(api_key="lb_live_…") as client:
    data = client.start("my-profile-id")
    ws, addr = data["ws"], data["debuggerAddress"]
    # …drive the browser…
    client.stop("my-profile-id")
```

## Connect recipes

### Playwright — Python (`connect_over_cdp`)

```python
from lobster_client import LobsterClient
from playwright.sync_api import sync_playwright

with LobsterClient(api_key="lb_live_…") as client:
    ws = client.start("my-profile-id")["ws"]
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws)
        page = browser.contexts[0].pages[0]
        page.goto("https://example.com")
    client.stop("my-profile-id")
```

### Playwright — JavaScript (`connectOverCDP`)

```js
import { LobsterClient } from '@lobster/local-api-sdk';
import { chromium } from 'playwright';

const client = new LobsterClient({ apiKey: 'lb_live_…' });
const { ws } = await client.connectPlaywright('my-profile-id');
const browser = await chromium.connectOverCDP(ws);
const page = browser.contexts()[0].pages()[0];
await page.goto('https://example.com');
await client.stop('my-profile-id');
```

### Puppeteer — JavaScript (`browserWSEndpoint`)

```js
import { LobsterClient } from '@lobster/local-api-sdk';
import puppeteer from 'puppeteer-core';

const client = new LobsterClient({ apiKey: 'lb_live_…' });
const { ws } = await client.connectPlaywright('my-profile-id');
const browser = await puppeteer.connect({ browserWSEndpoint: ws });
const [page] = await browser.pages();
await page.goto('https://example.com');
await client.stop('my-profile-id');
```

### Selenium — Python (`debugger_address`)

```python
from lobster_client import LobsterClient
from selenium import webdriver

with LobsterClient(api_key="lb_live_…") as client:
    addr = client.start("my-profile-id")["debuggerAddress"]
    opts = webdriver.ChromeOptions()
    opts.debugger_address = addr           # attach to the already-running profile
    driver = webdriver.Chrome(options=opts)
    driver.get("https://example.com")
    driver.quit()
    client.stop("my-profile-id")
```

## Testing

`cd js && node --test` runs the JS client's unit tests (a mock `fetch` verifies auth headers, envelope
unwrapping, and the retry/no-retry policy). The Python client is stdlib-only and importable directly.

An official, richer SDK surface (typed models across Py/JS/C#, plus an **MCP server** for AI agents) is
tracked in [`docs/specs/api-reference.md`](../../docs/specs/api-reference.md) §4–§5.
