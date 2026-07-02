# Contract — Rust core ⇄ Node engine-runner sidecar (stdio JSON-RPC)

The Rust desktop core spawns the engine-runner sidecar as a child process and talks to it over
**newline-delimited JSON on stdio**. Types are defined in `@lobster/shared-types` (`ipc.ts`) and are
the source of truth; this doc is the human-readable spec.

## Transport

- One JSON object per line on **stdin** (request) and **stdout** (response). No embedded newlines.
- stderr is for logs only, never protocol.
- The Rust side owns privilege, auth, and the profile store. The sidecar only launches/controls engines.

## Request

```jsonc
{ "id": "uuid", "method": "launch" | "stop" | "status" | "ping", "params": { ... } }
```

## Response

```jsonc
{ "id": "uuid", "ok": true,  "result": { ... } }
{ "id": "uuid", "ok": false, "error": { "code": "string", "message": "string" } }
```

`id` is echoed back for correlation.

## Methods

### `ping`
- params: `{}` → result: `{ "pong": true }`. Health/handshake.

### `startProfile`
- params (`StartProfileParams`): `{ profileId, engine, os, fingerprintSeed, fingerprintOverrides?, proxy?, userDataDir, headless? }`
- result: `LaunchResult` (`{ profileId, pid, ws, debuggerAddress }`).
- The high-level launch the Rust local API uses: the sidecar **derives** the fingerprint from the seed
  (+ overrides + best-effort proxy-exit geo via `deriveGeoFromExitIp`), then launches. The Rust core
  never computes fingerprints — it only forwards the profile's stored fields.

### `launch`
- params (`LaunchParams`): the low-level form, carrying an already-resolved `fingerprint`.
  ```jsonc
  {
    "profileId": "string",
    "engine": "lobium" | "chromium",
    "userDataDir": "/abs/path/to/profile",   // persistent per-profile dir
    "fingerprint": { /* fully-resolved coherent Fingerprint (post-geo) */ },
    "proxy": { "type": "http|https|socks5", "host": "...", "port": 8080, "username?": "", "password?": "" },
    "headless": false
  }
  ```
- result (`LaunchResult`):
  ```jsonc
  { "profileId": "string", "pid": 12345, "ws": "ws://127.0.0.1:PORT/devtools/browser/...", "debuggerAddress": "127.0.0.1:PORT" }
  ```
- Behavior: launch the engine with the per-profile `userDataDir` + proxy; apply the **JS-safe**
  fingerprint surfaces via patchright isolated init scripts; deep surfaces are native on **Lobium**
  (best-effort on the interim Chromium until Lobium ships). Return the CDP endpoints. Enforce
  single-active-instance per `profileId`.

### `stop`
- params (`StopParams`): `{ "profileId": "string" }` → result: `{}` (ok). Gracefully close the engine.

### `status`
- params (`StatusParams`): `{ "profileId?": "string" }`
- result (`StatusResult`): `{ "running": [ { "profileId", "pid", "ws", "debuggerAddress" } ] }`

## Errors (code values)

`bad_json` · `unknown_method` · `not_found` (profile not running) · `already_running` ·
`launch_failed` · `internal`.

## Notes

- Day 0 ships the loop + `ping`; `launch`/`stop`/`status` return `not implemented` until Day 1.
- Both engines speak this one contract: `chromium` is the interim prebuilt engine; `lobium` is our
  flagship custom build (served by a patched Chromium via patchright until the native build ships).
