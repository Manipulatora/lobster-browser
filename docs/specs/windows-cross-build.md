# SPEC — Windows installer, cross-built from Linux

> **Status: PROVEN (experimental cross-compile).** On 2026-07-09 a Windows x64 NSIS installer
> (`Lobster Browser_0.0.0_x64-setup.exe`) was produced **entirely on the Linux GPU box**, with no Windows
> machine, by cross-compiling the Tauri desktop shell to `x86_64-pc-windows-msvc` and bundling it with a
> Linux-hosted `makensis`. This document is the exact, reproducible recipe plus an honest statement of
> what the artifact **is** and **is not**, so the next agent can rebuild it and knows what still needs a
> real Windows host.
>
> Read alongside [`PRODUCTION-ROADMAP.md`](../PRODUCTION-ROADMAP.md) (DSK-5/11 packaging, SEC-14a signing)
> and [`PROJECT-STATUS.md`](../PROJECT-STATUS.md).

---

## 1. What was produced

| Artifact | Size | Type | Notes |
|---|---|---|---|
| `Lobster Browser_0.0.0_x64-setup.exe` | ~4.9 MB | NSIS installer (PE32) | Per-user install of the desktop shell; downloads the WebView2 runtime on first install |
| `lobster-desktop.exe` | ~17 MB | app binary (PE32+ x86-64) | The Tauri/Rust shell + React UI + Axum local API, statically linking bundled SQLite |

Both are copied to `dist-windows/` in the repo root (git-ignored — build output, never committed).

The installer was built by the Tauri v2 bundler; it embeds the standard Nullsoft manifest, is
PerMonitorV2 DPI-aware, and requests `asInvoker` (per-user, no forced elevation).

---

## 2. Why this path (and the honest limitation)

Chromium-family apps do not cross-compile cleanly, but the **Lobster desktop shell is not Chromium** —
it is a Tauri app whose UI is rendered by the OS WebView (WebView2/Edge on Windows). A Tauri shell is a
normal Rust binary plus a web asset bundle, so it **can** be cross-compiled to Windows from Linux using
the MSVC target + a Linux-hosted `makensis`. That is what this recipe does.

**What the installer IS:** a real, installable Windows product shell — it installs `lobster-desktop.exe`,
Start-menu/uninstall entries, and (on first run) the WebView2 runtime, then launches the full React
UI (Profiles/Proxies/Templates/Pricing, the create-profile wizard, the fingerprint editor) and the local
automation API.

**What the installer is NOT (yet):**

1. **Not code-signed.** No Authenticode signature (SEC-14a). Windows SmartScreen will warn on a freshly
   downloaded unsigned installer. Signing is only supported on a Windows host by default, or via a custom
   `bundle > windows > sign_command`; it needs a real code-signing certificate.
2. **Sidecar JS is now listed in `bundle.resources`** (`packages/engine-runner/dist` →
   `sidecar/engine-runner/`). The desktop core resolves `LOBSTER_SIDECAR` → packaged
   `sidecar/engine-runner/index.js` → dev source tree. **Still missing:** a bundled Node runtime
   (`LOBSTER_NODE_BIN` / `externalBin`) and a **Windows Lobium engine** (the 7.3 GB binary on this box
   is Linux-only). So the installed shell can find the sidecar script, but launching a profile on
   Windows still needs a Windows Node + engine present.
3. **Experimental.** Tauri prints "Cross-platform compilation is experimental and does not support all
   features." A matching Windows host is still recommended for the **release** build (icon resource
   embedding, signing, and WiX/MSI all behave best natively).

In short: this proves the **Windows packaging pipeline works from Linux** and the sidecar *script*
bundling plumbing (DSK-5/11 partial). Turning it into the *full* shippable product still needs a
bundled Node runtime + Windows engine and signing (SEC-14a).

---

## 3. Toolchain (all installed under the workspace `.tools/`, no root/apt)

The sandbox only allows writes under the workspace, so every tool lives in
`/home/chrome/browser/.tools/` and nothing was installed system-wide.

| Tool | Version | How it was obtained | Purpose |
|---|---|---|---|
| Node.js | 22.14.0 | official tarball → `.tools/node22` | frontend build + tauri-cli |
| Rust | 1.96.1 (rustup) | `sh.rustup.rs` → `RUSTUP_HOME`/`CARGO_HOME` in `.tools` | cross-compiler |
| Rust target | `x86_64-pc-windows-msvc` | `rustup ... -t x86_64-pc-windows-msvc` | Windows MSVC ABI |
| `cargo-xwin` | 0.18.4 | `cargo install cargo-xwin` | downloads the MS CRT/SDK + drives clang-cl/lld-link |
| LLVM | 18.1.8 | GitHub `clang+llvm-...-x86_64-linux-gnu` → `.tools/llvm` | `clang-cl`, `lld-link`, `llvm-lib`, `llvm-rc` for the MSVC target |
| `libtinfo.so.5` | ncurses 5.9 | extracted from Ubuntu `libtinfo5` deb → `.tools/shim` | the LLVM 18 build links against it |
| NSIS (`makensis`) | 3.08 | Ubuntu `nsis` + `nsis-common` debs → `.tools/nsis` | build the installer on Linux |
| Tauri CLI | v2 (`@tauri-apps/cli`) / tauri 2.11.5 | npm devDependency | orchestrates build + NSIS bundle |

### Notable gotchas (already solved, documented so they aren't rediscovered)

- **`clang-cl` needs `libtinfo.so.5`.** The LLVM 18 Linux build links the legacy ncurses 5 lib. The
  distro only ships `libtinfo.so.6` and the version symbols differ, so `libtinfo.so.6` cannot substitute.
  Fix: extract `libtinfo.so.5.9` from the Ubuntu `libtinfo5` package into `.tools/shim` and put it on
  `LD_LIBRARY_PATH`.
- **`.deb` payloads are zstd-compressed** and the box has no `zstd` CLI. Fix: `libzstd.so.1` is present, so
  a tiny `ctypes` streaming decompressor (`.tools/nsis/unzstd.py`) extracts `data.tar.zst`.
- **Ubuntu `makensis` hard-codes `NSISDIR=/usr/share/nsis`** (unwritable here) and Tauri invokes it as
  `makensis.exe`. Fix: a wrapper at `.tools/nsis/bin/makensis` exports `NSISDIR` to the workspace-extracted
  `usr/share/nsis` and `LD_LIBRARY_PATH` for the shim, with a `makensis.exe` symlink so Tauri finds it on
  `PATH`.
- **Tauri needs a real icon set.** The repo shipped only `icon.png`; `npm run tauri icon` regenerated the
  full set incl. `icon.ico`, and `tauri.conf.json` `bundle.icon` was pointed at the generated files.

---

## 4. Reproducible build recipe

From a clean checkout on this (or an equivalent Ubuntu 24.04) Linux box:

```bash
# 0) Workspace-local tool locations (nothing system-wide).
export TOOLS=/home/chrome/browser/.tools
export PATH="$TOOLS/nsis/bin:$TOOLS/node22/bin:$TOOLS/cargo/bin:$TOOLS/llvm/bin:$PATH"
export RUSTUP_HOME="$TOOLS/rustup" CARGO_HOME="$TOOLS/cargo"
export LD_LIBRARY_PATH="$TOOLS/shim"           # libtinfo.so.5 for clang-cl
export XWIN_ACCEPT_LICENSE=1 XWIN_CACHE_DIR="$TOOLS/xwin-cache"

# 1) One-time toolchain setup (see §3 for how each was fetched):
#    - Node 22 tarball -> $TOOLS/node22
#    - rustup + Rust 1.96.1 + target x86_64-pc-windows-msvc -> $TOOLS/{rustup,cargo}
#    - cargo install cargo-xwin
#    - LLVM 18.1.8 linux tarball -> $TOOLS/llvm
#    - libtinfo5 deb -> $TOOLS/shim/libtinfo.so.5
#    - nsis + nsis-common debs -> $TOOLS/nsis (+ the makensis wrapper in $TOOLS/nsis/bin)

# 2) Install workspace deps + build the shared TS package the UI imports.
cd /home/chrome/browser/lobster-browser
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
npm run build --workspace @lobster/cookies

# 3) (once) generate the full icon set incl. .ico
cd apps/desktop && npm run tauri icon src-tauri/icons/icon.png && cd ../..

# 4) Cross-build the Windows installer.
cd apps/desktop
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

Output (under the cargo target dir):

```
.../x86_64-pc-windows-msvc/release/lobster-desktop.exe
.../x86_64-pc-windows-msvc/release/bundle/nsis/Lobster Browser_0.0.0_x64-setup.exe
```

---

## 5. How to smoke-test on Windows

1. Copy `Lobster Browser_0.0.0_x64-setup.exe` to a Windows 10/11 x64 machine (or clean VM).
2. Run it. SmartScreen will warn (unsigned) → "More info → Run anyway" for testing.
3. It installs per-user and, if WebView2 is absent (Win10 without it), downloads the runtime. Win11 ships
   WebView2, so it launches immediately.
4. Launch **Lobster Browser** from the Start menu. Expected: the React UI opens (Profiles/Proxies/
   Templates/Pricing), and the local automation API binds on loopback.
5. Expected limitation: *launching a browser profile* will not fully work until the sidecar + a Windows
   engine are bundled (DSK-5/11). This build validates the **install + shell + UI**, not the full launch
   path on Windows.

---

## 6. What remains to make this the real shippable Windows product

| ID | Task | Why |
|---|---|---|
| DSK-5/11 | Bundle the `engine-runner` Node sidecar (e.g. as a packaged single-file binary) + a **Windows Lobium build** as Tauri `externalBin`/`resources`; resolve them at runtime | so a clean-VM install can actually launch profiles with no system Node/engine |
| SEC-14a | Authenticode signing + timestamp (real cert), or a `sign_command` in `tauri.conf.json` | remove SmartScreen warnings; required for GA |
| ENG-7a | A **Windows Lobium build host** (Chromium fork must be built on Windows) | the native engine + its config channel on Windows |
| DSK auto-update | Wire the Tauri updater with Ed25519 signing | in-product updates |
| QA | Clean-VM install/launch/stop E2E on real Windows | prove the packaged product, not just the shell |

Once DSK-5/11 + SEC-14a land and a Windows Lobium binary exists, the same command in §4 (plus signing)
produces the **full** signed Windows product. A native Windows host is recommended for the release build.
