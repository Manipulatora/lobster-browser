# SPEC — Linux product package (deb + local install)

> **Status: PROVEN (2026-07-09).** A Linux `.deb` of the Lobster desktop shell was built on this
> machine (`ivyhfx` VPS), installed under `~/.local/share/lobster`, and proven end-to-end:
> **UI starts → sidecar (bundled Node) → create/list profile → Launch → native Lobium Chrome/152
> runs with CDP** (`product-e2e.mjs` PASS).
>
> Read alongside [`windows-cross-build.md`](windows-cross-build.md).

---

## 1. What was produced

| Artifact | Size | Notes |
|---|---|---|
| `dist-linux/Lobster Browser_0.0.0_amd64.deb` | ~58 MB | Shell + bundled Node + self-contained sidecar |
| `dist-linux/lobster-desktop` | ~23 MB | Release binary |
| `dist-linux/lobium-runtime/` | ~1.0 GB | Stripped Lobium (`chrome` + `.so` + paks/locales) — **not** the full `out/` tree |
| `~/.local/share/lobster/` | ~1.2 GB | User-local install (deb extract + lobium-runtime) |
| `~/.local/bin/lobster-browser` | symlink | Launcher → `dist-linux/run-lobster.sh` |

**Honest scope:** the `.deb` ships the **UI shell + Node + sidecar**. Lobium is installed beside it
(hybrid) because a 1 GB engine inside every deb/AppImage update is impractical. The launcher env
wires `LOBSTER_LOBIUM_BIN` / `LOBSTER_NODE_BIN` / `LOBSTER_SIDECAR` so Launch works with no monorepo.

On this build VPS (no NVIDIA), the install defaults to `LOBSTER_GPU=software` (SwiftShader).

---

## 2. Rebuild / install (this machine)

```bash
# Optional overrides:
#   LOBSTER_LOBIUM_SRC=$HOME/lobium-build/src/out/Lobium
#   LOBSTER_GPU=software   # or gpu + LOBSTER_ANGLE_BACKEND=vulkan on NVIDIA hosts

cd /home/ivyhfx/browser   # or your clone root
bash scripts/build-linux-product.sh
```

Start the installed UI:

```bash
export PATH="$HOME/.local/bin:$PATH"
lobster-browser
# or: dist-linux/run-lobster.sh
```

---

## 3. End-to-end proof (verified)

| Step | Result |
|---|---|
| Bundled sidecar | OK |
| `product-e2e.mjs` with installed Lobium env | **PASS** (create → Lobium → cookies → navigate → screenshot → stop) |
| Installed GUI starts | Sidecar spawn: packaged Node + sidecar paths |
| Local API `/api/v1/health` | `{ status: ok }` |
| CDP `/json/version` | `Chrome/152.0.7928.0` (native Lobium) |

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
