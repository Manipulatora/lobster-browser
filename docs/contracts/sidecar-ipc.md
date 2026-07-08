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
{ "id": "uuid", "method": "startProfile" | "launch" | "stop" | "status" | "ping", "params": { ... } }
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
- params (`StartProfileParams`):
  `{ profileId, engine, os, osVersion?, hostCalibration?, fingerprintSeed, fingerprintOverrides?, proxy?, cookiesImport?, extensions?, userDataDir, headless? }`
- result: `LaunchResult` (`{ profileId, pid, ws, debuggerAddress }`).
- The high-level launch the Rust local API uses: the sidecar **derives** the fingerprint from the seed
  (+ overrides + best-effort proxy-exit geo via `deriveGeoFromExitIp`), then launches. The Rust core
  never computes fingerprints — it only forwards the profile's stored fields.
- When `hostCalibration` is present, the sidecar validates it and derives from the captured host
  hardware instead of the fallback catalog. The host OS must match `os`; software-rendered host
  snapshots are rejected before launch.
- `fingerprintOverrides` may include policy fields (`renderer`, `webrtc`, `hardwareNoise`,
  `mediaDevices`). The sidecar resolves these into `fingerprintPolicy`/`webrtcPolicy` and writes them to
  `lobium-fp.json` on native Lobium launches.

### `launch`
- params (`LaunchParams`): the low-level form, carrying an already-resolved `fingerprint`.
  ```jsonc
  {
    "profileId": "string",
    "engine": "lobium" | "chromium",
    "osVersion": "Windows 11 23H2",
    "userDataDir": "/abs/path/to/profile",   // persistent per-profile dir
    "fingerprint": { /* fully-resolved coherent Fingerprint (post-geo) */ },
    "fingerprintPolicy": {
      "renderer": { "mode": "host" },
      "webrtc": "default_public_interface_only",
      "hardwareNoise": { "webgl": true, "canvas": true, "audio": true, "clientRects": false },
      "mediaDevices": { "cameras": 1, "microphones": 1, "speakers": 2, "stableDeviceIds": true }
    },
    "webrtcPolicy": "default_public_interface_only",
    "proxy": { "type": "http|https|socks5", "host": "...", "port": 8080, "username?": "", "password?": "" },
    "cookiesImport": { /* stored cookie draft metadata */ },
    "extensions": [{ "source": "chrome_web_store", "enabled": true, "url": "https://..." }],
    "headless": false
  }
  ```
- result (`LaunchResult`):
  ```jsonc
  { "profileId": "string", "pid": 12345, "ws": "ws://127.0.0.1:PORT/devtools/browser/...", "debuggerAddress": "127.0.0.1:PORT" }
  ```
- Behavior: launch the engine with the per-profile `userDataDir` + proxy; apply the **JS-safe**
  fingerprint surfaces through CDP; deep surfaces are native on **Lobium**. When native Lobium is
  discovered, the launcher writes `<userDataDir>/lobium-fp.json` and passes
  `--lobium-fp-config=<path>`; otherwise `lobium` falls back to the interim Chromium path for dev/CI.
  Return the CDP endpoints. Enforce single-active-instance per `profileId`.

### `stop`
- params (`StopParams`): `{ "profileId": "string" }` → result: `{}` (ok). Gracefully close the engine.

### `status`
- params (`StatusParams`): `{ "profileId?": "string" }`
- result (`StatusResult`): `{ "running": [ { "profileId", "pid", "ws", "debuggerAddress" } ] }`

## Errors (code values)

`bad_json` · `unknown_method` · `not_found` (profile not running) · `already_running` ·
`launch_failed` · `internal`.

## Notes

- Both engines speak this one contract: `chromium` is the interim prebuilt engine; `lobium` is our
  flagship custom build when a binary is provided/discovered, with a clean fallback to interim Chromium
  for developer environments without the native artifact.
