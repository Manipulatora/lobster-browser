# 🦞 @lobster/desktop

The Lobster Browser **desktop agent**: a Tauri 2 (Rust) core that manages profiles/proxies and
launches browser engines, with a React + TypeScript + Vite UI and an Axum-based **local automation
API** (loopback-only) for Playwright/Puppeteer/Selenium integrations.

> **Current state:** profile CRUD, SQLite storage, launch/stop IPC, the shared sidecar path, and the
> loopback local automation API are wired. The current React UI is still a dark scaffold; the production
> target is the light/red shell and create-profile wizard in
> [`docs/specs/product-ui-ux-plan.md`](../../docs/specs/product-ui-ux-plan.md).

## Prerequisites

- **Node** `>=22 <25` and **npm** `>=10` (repo root `.nvmrc`).
- **Rust** pinned by the root `rust-toolchain.toml` — the TS packages don't need it, but this app does.
  Install via `rustup`:
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
  The toolchain is pinned by the root `rust-toolchain.toml`.
- Platform webview + build deps for Tauri 2 (WebView2 on Windows, `webkit2gtk` on Linux, Xcode
  CLT on macOS) — see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Run

From this directory (`apps/desktop/`):

```bash
npm install          # once this app has joined the root workspaces (Track A, Day 1)
npm run tauri dev    # builds the Rust core, starts Vite (port 5173), opens the app window
```

Other scripts:

| Script              | What it does                                              |
| ------------------- | -------------------------------------------------------- |
| `npm run dev`       | Vite dev server only (no Tauri window).                  |
| `npm run build`     | `tsc` typecheck + `vite build` → `dist/` (frontend).     |
| `npm run typecheck` | `tsc --noEmit`.                                          |
| `npm run tauri`     | Passthrough to the Tauri CLI (`tauri build`, etc.).      |

## File map

```
apps/desktop/
  package.json            @lobster/desktop — deps + scripts
  index.html              Vite entry document; mounts #root
  vite.config.ts          React plugin, port 5173, clearScreen off (Tauri-friendly)
  tsconfig.json           Standalone TS config: DOM libs + react-jsx + bundler resolution
  src/
    main.tsx              React 18 client entrypoint
    App.tsx               Current dashboard shell; target IA is Profiles/Proxies/Templates/Pricing
    styles.css            Current dark scaffold; target is light/red production UI
  src-tauri/
    Cargo.toml            Crate `lobster-desktop`, lib `lobster_desktop_lib`
    build.rs              tauri_build::build()
    tauri.conf.json       App/window/bundle config. NOTE: bundle.icon is [] on purpose —
                          real icons are generated at packaging time on Day 8.
    capabilities/
      default.json        Main-window capability: core:default + shell:allow-execute
    src/
      main.rs             Thin shim → lobster_desktop_lib::run()
      lib.rs              run(): tracing + background local API + Tauri builder + commands
      local_api.rs        Axum router (127.0.0.1) — health + profile start/stop/list/status
      profile_store.rs    rusqlite (bundled SQLite) schema + init()
```

## Architecture notes

- **IPC (UI → Rust):** the UI calls `invoke('app_version')`, profile CRUD commands, and
  `launch_profile`/`stop_profile`; commands are registered in `src-tauri/src/lib.rs`.
- **Local automation API:** runs on a background Tokio runtime (`127.0.0.1:53211`), separate from
  the Tauri event loop. The `{ code, data, msg }` envelope mirrors `@lobster/shared-types`
  `ApiResponse`. Bearer API-key auth is wired; rate limiting remains planned.
- **Profile store:** `profile_store.rs` mirrors the shared `Profile` type. Encryption of
  cookie/storage blobs and cloud sync remain planned productization work.
- **Domain types:** imported from `@lobster/shared-types` so the desktop never drifts from the
  backend/sidecar wire contracts.
