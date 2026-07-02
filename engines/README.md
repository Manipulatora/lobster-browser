# Engines

Lobster orchestrates two **pinned, prebuilt** browser engines. They are large and are **never
committed** — `download-engines.mjs` fetches them into `engines/bin/` on first run (git-ignored).

- **Camoufox** — High-Stealth engine (native-patched Firefox). Recommended for the hardest anti-bot
  targets; genuine Gecko network + render stack.
- **ungoogled-chromium** — the default engine base, driven via patchright.

## Usage

```bash
node engines/download-engines.mjs            # dry run — prints what it would fetch
node engines/download-engines.mjs --download # actually download for this platform
```

Pinned versions live in [`versions.json`](versions.json). Confirm exact release/asset/sha256 in
ticket **T-002**. Rebrand engine binaries before any redistribution (Phase 8 / packaging).
