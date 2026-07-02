# @lobster/local-api-sdk

Tiny client examples for the [Local Automation API](../../docs/contracts/local-automation-api.md).

- [`js/`](js/) — ESM JavaScript client (`LobsterClient`).
- [`python/`](python/) — stdlib-only Python client (`lobster_client.py`).

Both `start()` a profile and return `{ ws, debuggerAddress }` so you can drive it with
Playwright/Puppeteer (`connectOverCDP(ws)`) or Selenium (`debuggerAddress`). Official, richer SDKs
(retries, typed models, MCP server) are a later deliverable.
