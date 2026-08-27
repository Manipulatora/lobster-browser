# Windows installers 1.0.0 — bundled and web

Built 2026-08-27 on the Windows host, from one checkout at `c9ad0da`, differing by one build flag.

| | bytes | sha256 |
|---|---|---|
| `Lobster-Browser-1.0.0-x64-setup.exe` (**bundled**) | 241,599,086 | `375755f6f371a89714f930f73bf750b902e97dca5261ede128b28b7b3c76dea2` |
| `Lobster-Browser-1.0.0-x64-web-setup.exe` (**web**) | 30,710,140 | `250788f6889529402217583d98910afa8c6b91153599fbd741671541fe8ca4b7` |

Names are the ones `downloads.catalog.ts:48-49` derives — bundled is the plain `-x64-setup.exe`, web
carries the `-web-` infix. On the Linux box:

```bash
git lfs pull --include='release/win-x64/*'
cd release/win-x64 && sha256sum -c SHA256SUMS
```

## How they were built

```powershell
scripts\build-windows-product.ps1                                     # web
scripts\build-windows-product.ps1 -Bundled `
  -EngineRuntime dist-win\lobium-runtime-152.0.7977.42-fp             # bundled
```

`-Bundled` stages the packaged runtime into `resources\lobium`, writes the stamp beside it, and adds
`--config src-tauri/tauri.bundled.conf.json`. The overlay config is the Linux side's, unchanged.

## The stamp

The archive digest was **not** re-derived. The published archive already on this host hashes to
`adcbb43d…`, which is exactly what `engine-manifest.json` names, so the reproducibility trap the
brief describes — `Compress-Archive` embedding timestamps and yielding a different digest for
identical content — does not arise: no archive was rebuilt.

The digest is also never typed twice. `build-windows-product.ps1` reads it out of
`engine-manifest.json` at stage time and writes it to the stamp, so the two cannot diverge by
construction.

```
version=152.0.7977.42
sha256=adcbb43d7cc33c2f5ca1b42fc059e2971259f0f05aa3e2701bf5d0e8e3c797bd
```

94 bytes, LF, no BOM, trailing newline — written with `File.WriteAllText` and `UTF8Encoding($false)`,
because `Set-Content` would emit CRLF and every comparison against
`format!("version={}\nsha256={}\n")` would fail silently. Verified byte-identical to the manifest
entry **after** NSIS packaging and installation, not just in the tree.

## Verified, per the brief's step 5

Clean each time: install directory, `%LOCALAPPDATA%\lobster` **and**
`%APPDATA%\com.lobster.browser` removed, and `LOBSTER_ENGINE_URL`, `LOBSTER_ENGINE_SHA256`,
`LOBSTER_ENGINE_VERSION`, `LOBSTER_LOBIUM_BIN`, `LOBSTER_FONTS_DIR` all confirmed unset.

**Bundled**

```
install    exit 0 in 79s, 576 files, 0.67 GB
payload    lobium\chrome.exe present, lobium\.lobium-engine-version present
stamp      == the manifest's win-x64 entry
launch     watched 300s: NO managed cache, NO .lobium-engine.download partial
verdict    PASS - no download of any kind
```

The 300-second watch matters. The background updater runs *after* the window is up, so a short watch
would report "no download" for a bundled build whose stamp was wrong — the exact failure this test
exists to catch. This binary contains that updater (`c9ad0da`); the earlier build I tested did not,
so that earlier result proved nothing and is not cited here.

**Web**

```
install    exit 0 in 14s, 20 files, 0.11 GB
payload    no lobium\chrome.exe, no stamp
launch     downloaded from lobrowser.com, 556 files / 578.8 MB
verdict    PASS
```

**Android profile on the bundled build** — launched through the product's own API, `code=0`, 12 engine
processes off `<install>\lobium\chrome.exe`, managed cache still absent afterwards. That path
exercises the `device-frame` capability gate a mobile launch requires.

## A defect found while testing — not caused by bundling

**The first profile launch after a fresh install reports success and nothing runs.**

```
bundled, 1st launch   start code=0 pid=6076  -> 0 engine processes after 25s; stop: "is not running"
bundled, retry                                -> 12 engine processes
web,     1st launch   start code=0 pid=3892  -> 0 engine processes after 12s
web,     retry                                -> 11 engine processes
```

It reproduces on **both** installers, so it is not bundling and not this change — it is the product's
behaviour on a genuinely fresh install. The browser gets far enough to create the profile directory
(175 files) and the API returns a pid, but that pid is gone and no engine process ever appears. The
immediate retry always works, and every launch after it.

Two reasons it deserves attention rather than a footnote: a new user's very first "Launch" does
nothing while the app reports success, which is the worst moment for that; and "reported success,
nothing ran" is a shape this area has produced before and has explicit guards against elsewhere.

I have not found the mechanism. It needs the sidecar's own stderr from that first launch, which is
piped into `tracing` and not written to a file I could recover here.
