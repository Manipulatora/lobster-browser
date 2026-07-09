# SPEC — Linux product package (deb + local install)

> **Status: PROVEN (2026-07-09).** A Linux `.deb` of the Lobster desktop shell was built on this
> machine, installed under `~/.local/share/lobster`, and proven end-to-end: **UI starts → sidecar
> (bundled Node) → create/list profile → Launch → native Lobium Chrome/152 runs with CDP**.
>
> Read alongside [`windows-cross-build.md`](windows-cross-build.md) and
> [`PROJECT-STATUS.md`](../PROJECT-STATUS.md) (DSK-5/11).

---

## 1. What was produced

| Artifact | Size | Notes |
|---|---|---|
| `dist-linux/Lobster Browser_0.0.0_amd64.deb` | ~55 MB | Shell + bundled Node 22 + self-contained sidecar |
| `dist-linux/lobster-desktop` | ~23 MB | Release binary |
| `dist-linux/lobium-runtime/` | ~1.0 GB | Stripped Lobium (`chrome` + `.so` + paks/locales) — **not** the 7.3 GB `out/` tree |
| `~/.local/share/lobster/` | ~1.2 GB | User-local install (deb extract + lobium-runtime) |
| `~/.local/bin/lobster-browser` | symlink | Launcher → `dist-linux/run-lobster.sh` |

**Honest scope:** the `.deb` ships the **UI shell + Node + sidecar**. Lobium is installed beside it
(hybrid) because a 1 GB engine inside every deb/AppImage update is impractical. The launcher env
wires `LOBSTER_LOBIUM_BIN` / `LOBSTER_NODE_BIN` / `LOBSTER_SIDECAR` so Launch works with no monorepo.

---

## 2. Rebuild / install (this machine)

```bash
export PATH=/home/chrome/browser/.tools/node22/bin:/home/chrome/browser/.tools/cargo/bin:$PATH
export RUSTUP_HOME=/home/chrome/browser/.tools/rustup CARGO_HOME=/home/chrome/browser/.tools/cargo
export LOBSTER_LOBIUM_BIN=/home/chrome/lobium-build/src/out/Lobium/chrome
export LOBSTER_GPU=gpu LOBSTER_ANGLE_BACKEND=vulkan
export VK_ICD_FILENAMES=/home/chrome/browser/.gpu/nvidia_icd.json
export DISPLAY=:20.0

cd /home/chrome/browser/lobster-browser

# 1) Self-contained sidecar (includes @lobster/* + patchright + undici/socks…)
node scripts/bundle-sidecar.mjs

# 2) Strip Lobium runtime (~1GB)
bash scripts/package-lobium-runtime.sh dist-linux/lobium-runtime

# 3) Vendor Node into Tauri resources
mkdir -p apps/desktop/src-tauri/resources/node/bin
cp -a /home/chrome/browser/.tools/node22/bin/node apps/desktop/src-tauri/resources/node/bin/node

# 4) Build .deb (tauri.conf.json resources: sidecar + node)
cd apps/desktop && npm run tauri -- build --bundles deb

# 5) Install user-local (no sudo) — see scripts/build-linux-product.sh
```

Or run the orchestrator:

```bash
bash scripts/build-linux-product.sh
```

Start the installed UI:

```bash
lobster-browser
# or: dist-linux/run-lobster.sh
```

---

## 3. End-to-end proof (verified)

| Step | Result |
|---|---|
| Bundled sidecar `ping` | OK |
| `product-e2e.mjs` with installed Lobium env | **PASS** (create → headful Lobium → cookies → navigate → screenshot → stop) |
| Installed GUI starts | Sidecar spawn log: packaged Node + sidecar paths |
| Local API `/api/v1/health` | `{ status: ok }` |
| Profile list + `/api/v1/profile/start` | Returns `debuggerAddress` + `ws` |
| CDP `/json/version` | `Chrome/152.0.7928.0` (native Lobium) |
| `/api/v1/profile/stop` | OK |

UI Create Profile uses Tauri IPC (`create_profile`) into the same SQLite the local API lists/launches.

---

## 4. Layout

```
~/.local/share/lobster/
  bin/lobster-desktop
  lib/node/bin/node
  lib/sidecar/          # self-contained engine-runner
  lobium/chrome         # ~1GB runtime
  env                   # LOBSTER_* exports
~/.local/share/com.lobster.browser/
  profiles.sqlite       # app data (profiles, proxies, templates)
  local-api-key
  secrets.key
```

---

## 5. Remaining gaps

- System-wide `sudo dpkg -i` install path + `/opt/lobster/lobium` postinst
- AppImage target (deb proven; AppImage needs `appimagetool`/FUSE)
- Code signing / updater
- Bundle Lobium *inside* the deb (optional; size trade-off)
- GPU ICD path is machine-specific (`VK_ICD_FILENAMES`) — document per-distro defaults
