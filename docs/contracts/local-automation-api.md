# Contract — Local Automation API (developer-facing)

Served by the Rust desktop core (Axum) on a fixed loopback port (**default `127.0.0.1:53211`**).
This is the interface developers automate against — deliberately mirroring the proven AdsPower/Octo
contract so existing integrations port with near-zero friction.

## Conventions

- Base path: `/api/v1`.
- **Auth:** `Authorization: Bearer <api-key>` on every endpoint except `/health`. Keys are managed in
  the desktop UI / backend. (Enforced from Day 4.)
- **Envelope:** every response is `{ "code": number, "data": T | null, "msg": string }`,
  `code === 0` = success (matches `@lobster/shared-types` `ApiResponse`).
- Rate limits are applied per endpoint (Day 4).

## Endpoints

### `GET /api/v1/health`
No auth. → `{ "code": 0, "data": { "status": "ok" }, "msg": "success" }`

### `POST /api/v1/profile/start`
Body: `{ "profileId": "string", "headless?": false, "password?": "string" }`
→ `data` (`StartProfileResult`):
```jsonc
{
  "profileId": "string",
  "ws": "ws://127.0.0.1:PORT/devtools/browser/<id>",  // Playwright/Puppeteer: connectOverCDP(ws)
  "debuggerAddress": "127.0.0.1:PORT",                 // Selenium: options.debuggerAddress
  "webDriver": "http://127.0.0.1:PORT",                // optional
  "pid": 12345
}
```

### `POST /api/v1/profile/stop`
Body: `{ "profileId": "string" }` → `data: { "profileId", "stopped": true }`

### `GET /api/v1/profile/list`
→ `data`: `LocalApiListItem[]` = `[{ "profileId", "name", "running" }]`

### `GET /api/v1/profile/status?profileId=<id>`
→ `data` (`ProfileStatusResult`): `{ "profileId", "running", "ws?", "debuggerAddress?" }`

### `POST /api/v1/proxy/test`
Body: `{ "id?": "stored-proxy-id", "config": { "id": "px_1", "type": "http|https|socks5", "host": "string", "port": 1080, "username?": "string", "password?": "string" } }`
→ `data` (`ProxyTestResult`): `{ "ok": boolean, "latencyMs?": number, "geo?": { "ip", "countryCode", "timezone", ... }, "error?": "string" }`

If `id` is supplied, the desktop updates that stored proxy row's latest test status.

## Connect recipes

**Playwright (Node/Python):**
```js
const { ws } = (await fetch('http://127.0.0.1:53211/api/v1/profile/start', {
  method: 'POST', headers: { authorization: 'Bearer lb_...', 'content-type': 'application/json' },
  body: JSON.stringify({ profileId, password: '<only-if-profile-is-protected>' }) }).then(r => r.json())).data;
const browser = await chromium.connectOverCDP(ws);
```

**Selenium (Python):**
```python
opts = webdriver.ChromeOptions()
opts.debugger_address = data["debuggerAddress"]
driver = webdriver.Chrome(options=opts)
```

## Notes

- **Live (T-017).** `start`/`stop`/`status` are delegated to the engine-runner sidecar (the Rust core
  spawns it and speaks JSON-RPC over stdio); `start` looks the profile up in the local store and sends
  the sidecar a `startProfile` request, which derives the fingerprint from the profile's seed
  (+ overrides + best-effort proxy-exit geo) and launches — returning the real CDP `ws` + `debuggerAddress`.
- **Profile password:** if the profile has password protection enabled, `password` is required on
  `/profile/start`; otherwise the request fails before the sidecar launch.
- **Proxy test:** `/proxy/test` uses the Rust proxy checker shared with the desktop UI and supports
  HTTP, HTTPS, and SOCKS5 (`socks5h`) endpoints.
- **Auth:** `Authorization: Bearer <LOBSTER_API_KEY>` is enforced when the key env is set; the
  loopback-only server allows local dev when it is unset. Per-key rate limiting is a follow-up.
- An MCP server wrapper over these endpoints is a Phase 2 item.
