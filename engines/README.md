# Engines

Lobster runs on two engines: the flagship **Lobium** (our own Chromium build) and an interim
**Chromium**. Only the interim Chromium is downloaded here — **Lobium is BUILT from source** (see
[`../lobium/`](../lobium/)), never fetched. Until the native Lobium build ships, `lobium` is served by
this same prebuilt Chromium (patched, via patchright).

The interim engine is large and is **never committed** — `download-engines.mjs` fetches it into
`engines/bin/` on first run (git-ignored).

- **ungoogled-chromium** — the interim/everyday engine: a pinned, prebuilt Chromium driven via
  patchright.

## Usage

```bash
node engines/download-engines.mjs            # dry run — prints what it would fetch
node engines/download-engines.mjs --download # actually download for this platform
```

Pinned versions live in [`versions.json`](versions.json). Confirm exact release/asset/sha256 in
ticket **T-002**. Rebrand engine binaries before any redistribution (Phase 8 / packaging).
