# Windows release artifacts — 152.0.7977.42

Built on the Windows host, 2026-08-26, from the 35-patch series (i.e. **including** the Linux side's
`enable_widevine`, `fingerprint/webgpu-availability.patch` and `fingerprint/media-values-color.patch`).

These are carried through **Git LFS**. Read §3 before assuming this is how artifacts should travel.

---

## 1. What is here

| file | bytes | sha256 |
|---|---|---|
| `lobium-win-x64-152.0.7977.42.zip` | 290,775,298 | `adcbb43d7cc33c2f5ca1b42fc059e2971259f0f05aa3e2701bf5d0e8e3c797bd` |
| `Lobster-Browser-1.0.0-x64-setup.exe` | 30,696,111 | `e41aa3cf7e6b87c0c3831b9643f8385be206e8d67cb1b9f5d74d5e8105b856fd` |

`SHA256SUMS` carries the same digests in `sha256sum -c` format.

The engine archive's contents are attested independently of the zip: `LOBSTER_ENGINE.json` inside it
records 554 files and artifact-tree digest
`b1dbbb1d9df0a5ade7ed02bd58f14431b1ee42255194b04fcdb92f523837cf1e`, and
`scripts/verify-lobium-runtime.mjs` re-derives that from the extracted bytes.

**The engine source is not here, because it is already in the repo** — `lobium/patches/` (the series),
`lobium/src/` (the added `//components/lobium_fp/` module) and `lobium/build.ps1` / `build.sh`. That
is the whole point of the patch-series architecture: the fork is 35 patches plus one added directory,
not a Chromium tree. Reproducing this binary means applying that series to a pinned
`152.0.7977.42` checkout, which `build.ps1 -Run -Force` does.

## 2. Getting them on Ubuntu

```bash
git clone https://github.com/Manipulatora/lobster-browser   # or: git pull
cd lobster-browser

# LFS files arrive as small pointer files unless the client fetches them.
sudo apt-get install -y git-lfs && git lfs install
git lfs pull --include='release/win-x64/*'

cd release/win-x64
sha256sum -c SHA256SUMS          # must print OK for both
```

If a file is ~130 bytes and starts `version https://git-lfs.github.com/spec/v1`, that is the pointer,
not the artifact — `git lfs pull` has not run.

To publish the engine to its real home on that box:

```bash
sudo install -m 0644 lobium-win-x64-152.0.7977.42.zip \
  /var/www/lobster-downloads/download/engine/lobium-win-x64-152.0.7977.42.zip

# Then, from anywhere, prove the served bytes are the same ones:
curl -fsSL https://lobrowser.com/download/engine/lobium-win-x64-152.0.7977.42.zip \
  | sha256sum   # must equal adcbb43d…
```

Only once that matches should `scripts/bump-engine-version.mjs` run — the manifest's job is to name
bytes that exist at a URL, and it currently names a URL that returns HTTP 404.

## 3. Why this is a transfer path and not the distribution path

The product does **not** get its engine from git. `engine-manifest.json` names a URL and a SHA-256 on
`lobrowser.com`, and the Rust core streams and verifies it on first run. That decision is recorded in
the manifest's own note: one origin, under our control, for the whole install path.

This directory exists because the two build hosts needed to move ~300 MB between them and there was
no other route available from the Windows side.

**It does not scale, and should not become routine:**

* GitHub's free LFS tier is **1 GB storage and 1 GB/month bandwidth**. These two files are 306 MB, so
  one copy fits and one clone from Ubuntu consumes about a third of the monthly bandwidth. A second
  engine version puts storage at ~600 MB; a third exceeds the tier, at which point pushes start
  failing or the account is billed.
* LFS objects are not removed by deleting the file in a later commit. Pruning them is a deliberate,
  separate operation.
* Every engine rebuild produces a new 277 MB object. There have been several in one day.

The sustainable route is the one the architecture already specifies: upload to
`/var/www/lobster-downloads/download/engine/` on the production box and let the manifest point at it.
Once that is possible from the Windows host — or once someone with credentials moves one of these —
this directory should be emptied and its LFS objects pruned.

## 4. What is and is not fixed in this engine

Verified on the Windows host against this exact build:

| | |
|---|---|
| Android device frame | **works.** Viewport 411×914 with `--lobium-device-frame=phone --lobium-device-screen=412x915`, vs 1028×637 without. The previously published build ignored the switch entirely |
| capability contract | v3, **21** capabilities, `device-frame` and `font-isolation` present |
| `screen.colorDepth` vs CSS `(color:)` | **fixed.** 30 and 10 now agree; `color-gamut: p3`, `dynamic-range: high` |
| Vulkan validation-layer / mock-ICD manifests | removed from the runtime (554 files, was 556) |
| Widevine | **still rejects** `com.widevine.alpha` on a fresh profile, despite `enable_widevine = true`. The CDM is not bundled by design — it is fetched by Chromium's component updater — so a profile that has never fetched it still has no key system |
| `navigator.gpu` | **still no adapter on this host, and the patch is not at fault.** Measured: with the explicit `--enable-unsafe-webgpu` switch, and with `forceFallbackAdapter: true`, Dawn returns null anyway. `webgpu-availability.patch` works on Linux (verified there) but the switch is not the limiting factor on this Windows VM |

Neither of the last two is a reason to hold the artifact — both are open questions about the fix, not
defects introduced by it — but neither should be reported as closed on Windows.
