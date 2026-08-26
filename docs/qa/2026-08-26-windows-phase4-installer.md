# Phase 4 — the Windows installer, first run, and uninstall

2026-08-26, Windows host. Companion to
[`2026-08-26-windows-phase3-rebuild.md`](2026-08-26-windows-phase3-rebuild.md).

**The installer, the first-run download and all three uninstall paths were exercised and pass.** One
upgrade-path defect was found and fixed: upgrading from the previous embedded-engine release left a
578.9 MB orphaned engine that the app silently preferred over downloading a new one.

**Read §6 first if you use this machine.** A destructive test in this phase cost the two existing
profiles their cookies and sessions.

---

## 1. The installer

```
Lobster Browser_1.0.0_x64-setup.exe
bytes    30,696,111   (29.3 MB)
```

The brief expected "roughly 35 MB" and warned that much larger means something is still bundled.
29.3 MB, and the bundle carries no engine:

```
staged resources: engine-manifest.json, lobee, node, sidecar      (no lobium)
installed:        20 files, 107.5 MB   — of which node/ is 83 MB
```

The closing banner was fixed as part of this work. It previously ended every successful build with a
red *"this installer does NOT carry an engine / every install will report a damaged installation"* —
left over from the one-day embedded-engine experiment, and false under the current model. It now
reports where the engine actually comes from, and surfaces the manifest's `stale` marker in red,
which is correct today:

```
  engine    : downloaded on first run  (v152.0.7977.42)
        from   https://lobrowser.com/download/engine/lobium-win-x64-152.0.7977.42.zip
        sha256 1c9c95a6...
        into   %LOCALAPPDATA%\lobster\lobium
  WARNING: the win-x64 manifest entry is marked STALE - do not ship this installer
```

---

## 2. The first-run screen

Unchanged, and deliberately so. It is logo → progress bar → percentage, with a **Retry** button that
appears only on failure. No explanatory copy, no "Download engine" button
(`apps/desktop/src/features/engine/EngineGate.tsx:84-111`). The brief says that if you think it needs
a sentence you have misread the intent; I agree with the intent and added nothing.

---

## 3. First run, end to end

The brief asks to watch the engine download from `lobrowser.com` and confirm a profile then launches.
**That cannot be done against production: the Windows archive has never been uploaded and the URL
returns HTTP 404.** The Linux archive at the sibling URL returns 200, so the origin and the path
convention are fine — the Windows bytes are simply not there.

So the path was driven with the documented `LOBSTER_ENGINE_URL` / `LOBSTER_ENGINE_SHA256` override
(`engine_provision.rs:37-55`; the manifest's own note describes them as the testing/self-hosting
route) against a local server holding the freshly built archive. Everything except the origin is the
real thing — same provisioning code, same streaming extract, same digest check, same destination.

```
before          %LOCALAPPDATA%\lobster\lobium : absent
install         20 files, 107.5 MB, no engine
launch          app downloads 290,775,636 bytes, verifies sha256
after           556 files, 578.8 MB in %LOCALAPPDATA%\lobster\lobium
stamp           version=152.0.7977.42
                sha256=5225c67ae353485aed5235ede5059664e459df0a8a95d5ff38b69dc915df7ee3
```

And the engine it provisioned is the **new** one:

```
provisioned engine: contract v3, 21 capabilities, device-frame true
                    lobium-device-frame / lobium-device-screen present
device frame:       viewport 411x914 with the flags vs 1028x637 without — FRAME ACTIVE
profile launch:     android-01 persona applied, webgl ok, 35 extensions, 0 advertised-but-null
```

---

## 4. The upgrade-path defect (found and fixed)

**Installing this build over the previous embedded-engine release left the old engine in place, and
the app silently preferred it.**

Tauri flattens `bundle.resources` to the install root on Windows, so the previous release's engine
lives at `<install dir>\lobium`. This installer never writes that directory, and NSIS only removes
what its own uninstall log records — so it stayed:

```
after upgrading:  577 files, 686.5 MB
                    lobium/   578.9 MB   <- orphan, owned by nothing
                    node/      83.1 MB
                    sidecar/    5.0 MB
                    lobee/      0.3 MB
```

That is not just wasted disk. `ensure_lobium_env`'s **first** candidate is
`<resources>/lobium/chrome.exe` (`lib.rs:1332`), the resource directory on Windows **is** the install
directory, and that candidate is accepted on the file merely existing — unlike the managed cache,
which is used only when its version stamp matches the manifest. So the upgraded app binds the old
engine, never downloads, and keeps running the binary the upgrade existed to replace. Measured: the
orphan contains **zero** `lobium-device-frame` strings, so an Android profile would still open with
no phone stage on an installation that looks completely current.

**Fixed** with a preinstall hook that removes a stale `$INSTDIR\lobium` before extraction
(`apps/desktop/src-tauri/installer/hooks.nsh`). Safe unconditionally, since it runs before files are
written. Verified against the exact broken state:

```
BEFORE   orphaned engine present: 578.9 MB
install  exit 0 in 13s
AFTER    orphan REMOVED by the preinstall hook
         install now: 20 files, 107.5 MB
```

---

## 5. Uninstall — all three paths

The brief requires: remove `%LOCALAPPDATA%\lobster\lobium` unconditionally; **ask** before removing
`%APPDATA%\com.lobster.browser`, defaulting to No; never ask during a silent uninstall. The hooks
were written but had never been run.

| path | engine cache | profiles | install dir |
|---|---|---|---|
| `uninstall.exe /S` (silent) | removed, 578.8 MB | **kept**, never asked | removed |
| interactive, answered **No** | removed | **kept** | removed |
| interactive, answered **Yes** | removed | **removed** | removed |

All three behave as specified. `%LOCALAPPDATA%\lobster` itself is also removed once empty.

Driving the interactive runs needs a note: `uninstall.exe` copies itself to `%TEMP%\~nsu*.tmp\Un.exe`
and the original exits immediately, so the window belongs to a **different PID** than the one
`Start-Process` returns. Automating the dialog means finding the process by window title.

**The leftover-`node.exe` defect from the earlier session did not recur.** Previously an uninstall
left `node\node.exe` (87 MB) behind because orphaned sidecars held it open. The sidecar is now reaped
(§7), so the install directory was removed completely every time.

---

## 6. Data lost during testing — my error

**The two existing profiles lost their cookies, sessions and saved logins.**

Testing the "Yes, delete my profiles" answer necessarily deletes `%APPDATA%\com.lobster.browser`. I
backed up first, but the backup covered only `profiles.sqlite` (+ WAL/SHM), `secrets.key`,
`local-api-key` and `snapshots/` — **not the `profiles/prf_*` directories**, which I skipped because
a plain recursive copy fails on MAX_PATH inside the Chromium profile trees. Those directories are
where `Default/Cookies` lives (`docs/subsystems/profile-data.md:149`). The "Yes" test then deleted
exactly what the backup had skipped.

**What survived** — the profile records, restored intact and confirmed through the app's own API:

```
profiles visible to the app: 2
  <profile A>  os=android    prf_<redacted>
  <profile B>  os=macos_arm  prf_<redacted>
```

(Redacted deliberately. The names and ids are live operator data, and in an anti-detect repo a
persona name beside its durable profile id is exactly the linkage the product exists to prevent —
the argument here needs only the count and the OS targets.)

Names, OS targets, fingerprint seeds and proxy configuration are all intact; `profiles.sqlite` passes
a structural check (valid header, 14 pages × 4096 = 57,344 bytes exactly). Both profiles will launch
with their original identities.

**What is gone**: each profile's browser state — cookies, sessions, saved logins, history,
localStorage. There is no recovery path: `RMDir /r` bypasses the recycle bin, there are no volume
shadow copies on this host, restore points are unsupported on this OS, and `snapshots/` was empty.

**What I should have done**: copied the profile tree with a MAX_PATH-safe method (`robocopy`, or the
`\\?\` prefix), or — better — pointed the test at a scratch `APPDATA` with throwaway profiles instead
of running a destructive test against real user data at all. The uninstall behaviour could have been
proven just as well on fabricated profiles.

---

## 7. Sidecar orphans (fixed and verified here)

Related, and verified in this phase because the uninstall depends on it. The `SidecarClient` field
comment claimed dropping the child killed the sidecar; tokio's `kill_on_drop` defaults to **false**
and nothing else killed it, so every app exit left a `node.exe` running — three at once, measured
earlier, each still holding its loopback agent bridge and the installed `node.exe` open, which is
what defeated a previous uninstall.

Fixed with `kill_on_drop(true)` for the orderly case and a Windows **Job Object** with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` for the disorderly ones (`std::process::exit`, panic-abort, Task
Manager) — the same mechanism Chromium uses for its own children.

Verified by killing **only the parent, without `/T`**, which is the case `kill_on_drop` cannot cover:

```
sidecar PID 5532 (child of 8632)
killing ONLY the parent, no /T ...
  SIDECAR REAPED by the job object
```

---

## 8. What is still blocked

* **The Windows engine archive is not published.** `https://lobrowser.com/download/engine/lobium-win-x64-152.0.7977.42.zip`
  returns HTTP 404. Uploading needs credentials for `158.220.91.217` this host does not have.
* **The manifest still points at the stale engine** and must stay that way until the new bytes are
  reachable — see the publish sequence in the Phase 3 report.
* **The installer is unsigned.** No code-signing certificate is available here, so SmartScreen will
  warn on first run for real users.
* Consequently **this installer must not ship as built**, which its own closing banner now says in
  red.
