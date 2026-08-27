# Windows installer 1.0.0 — rebuild that fixes first run

| | |
|---|---|
| file | `Lobster-Browser-1.0.0-x64-setup.exe` |
| bytes | 30,676,454 |
| sha256 | `b2d3e75b107bd1336618fd0c8129d13bb925ab84a4a8ff100ee84b33656304c2` |
| built from | `apps/desktop/src-tauri/resources/engine-manifest.json` at `49e7324` |

**This replaces the installer currently served from `lobrowser.com`, which is broken.** Carried
through Git LFS — `git lfs pull --include='release/win-x64/*'` on the Linux box, then
`sha256sum -c SHA256SUMS`.

The engine is **not** here. It is already published and verified at
`https://lobrowser.com/download/engine/lobium-win-x64-152.0.7977.42.zip`
(`adcbb43d7cc33c2f5ca1b42fc059e2971259f0f05aa3e2701bf5d0e8e3c797bd`), so re-uploading it would only
burn LFS quota.

## What was wrong

`engine-manifest.json` is baked into the installer at package time, so an installer is only ever as
correct as the tree it was built from. The published installer was built before the engine was
republished, so the copy inside it still pinned the **old** engine:

```
                                        sha256 pinned inside   stale key
served installer  e41aa3cf…             1c9c95a6…              PRESENT
this rebuild      b2d3e75b…             adcbb43d…              absent
```

First run therefore downloaded the 290 MB engine that `lobrowser.com` now serves — which hashes to
`adcbb43d…` — compared it against the `1c9c95a6…` the installer expected, failed the check, and
retried forever. The `stale` key is the same story from the other side: the repo's own build script
treats it as a do-not-ship marker, and it was still in the shipped bytes.

Neither the manifest nor the engine needed changing. Both were already correct on `main`; only the
installer was stale.

## Verified before shipping

Every line below was measured on this host against this exact artifact.

**The engine the manifest points at is the right one.** Downloaded the full 290,775,298 bytes from
`lobrowser.com` and hashed them: `adcbb43d…`, matching the manifest. So the manifest and the origin
agree and the installer was the only stale piece.

**The manifest baked into the installer.** Installed it and read
`%LOCALAPPDATA%\Lobster Browser\engine-manifest.json` — the file that actually lands on a user's
disk:

```
version : 152.0.7977.42
url     : https://lobrowser.com/download/engine/lobium-win-x64-152.0.7977.42.zip
sha256  : adcbb43d7cc33c2f5ca1b42fc059e2971259f0f05aa3e2701bf5d0e8e3c797bd   PASS
stale   : absent                                                             PASS
```

byte-identical to the repo copy. The same read against the previously installed build returns
`1c9c95a6…` with `stale` present, so the check discriminates rather than passing everything.

**First run, clean, no overrides.** `LOBSTER_ENGINE_URL`, `LOBSTER_ENGINE_SHA256`,
`LOBSTER_ENGINE_VERSION` and `LOBSTER_LOBIUM_BIN` all confirmed unset, engine cache removed, install
directory removed:

```
install        exit 0 in 13s, 20 files, 107.4 MB
first launch   downloaded from lobrowser.com, hash check PASSED
engine cache   556 files, 578.8 MB in %LOCALAPPDATA%\lobster\lobium
stamp          version=152.0.7977.42
               sha256=adcbb43d7cc33c2f5ca1b42fc059e2971259f0f05aa3e2701bf5d0e8e3c797bd
app            opened, window "Lobster Browser", local API health ok
```

**A profile launches on the provisioned engine.** An Android profile started through the product's
own API: `code=0`, CDP endpoint live, 11 engine processes. That path also exercises the
`device-frame` capability gate, which a mobile launch requires — so the provisioned engine is proven
to carry it, not merely to download. Stopped cleanly afterwards, 0 processes left.

## Publishing it

```bash
sudo install -m 0644 Lobster-Browser-1.0.0-x64-setup.exe \
  /var/www/lobster-downloads/download/Lobster-Browser-1.0.0-x64-setup.exe

curl -fsSL https://lobrowser.com/download/Lobster-Browser-1.0.0-x64-setup.exe \
  | sha256sum   # must equal b2d3e75b…
```

`downloads.catalog.ts` already has the Windows row `published: true` pointing at that exact filename,
so replacing the file in place is the whole change — no catalog edit, and its `size: '29.3 MB'` still
holds (30,676,454 B vs the old 30,696,111 B).

Delete this directory and prune its LFS object once that is done; the free tier is 1 GB storage and
1 GB/month bandwidth, and this is a transfer path, not the distribution one.
