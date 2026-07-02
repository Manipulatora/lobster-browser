# Coding Standards — Lobster Browser

Shared conventions so code from Claude and Codex reads as one hand. Enforced by CI where possible.

## TypeScript (packages, backend, desktop frontend)

- **Strict everything.** `tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`. Do not weaken these.
- **ESM + NodeNext** for node-side packages: relative imports carry the `.js` extension
  (`import { x } from './x.js'`), and type-only imports use `import type`. (The desktop React
  frontend uses `moduleResolution: bundler` and does not need `.js` extensions.)
- **Domain types come from `@lobster/shared-types`.** Never redefine a wire type locally.
- **The API envelope is `{ code, data, msg }`** (`code === 0` = success) — use the `ok()` / `err()`
  helpers from shared-types.
- Prefer `type`/`interface` over `any`. If you must escape the type system, use `unknown` + a
  narrowing guard, not `any`.
- 2-space indentation, single quotes, semicolons, trailing commas (Prettier config at repo root).
- Name things fully: `deriveFingerprint`, not `derFp`. Match the surrounding file's idiom.
- Errors: throw `Error` with actionable messages; never swallow errors silently.

## Rust (`apps/desktop/src-tauri`)

- 4-space indent; `cargo fmt` clean; `cargo clippy -- -D warnings` clean.
- No `.unwrap()`/`.expect()` on paths reachable from user input or IO in production paths — use
  `anyhow::Result` and `?`. `expect()` is acceptable only for genuinely-unrecoverable startup invariants.
- The Rust core is the **privileged control plane**: it owns auth, the profile store, and the local
  API; it talks to the engine-runner sidecar only over the documented stdio JSON-RPC contract.
- Keep `unsafe` out unless justified with a comment and reviewed by Claude.

## Tests

- Node packages use the built-in `node:test` runner. Co-locate as `*.test.ts`.
- Every bug fix adds a regression test. Every fingerprint-surface change adds a coherence assertion.
- Prefer deterministic tests (seeded PRNG, static geo provider) over network-dependent ones.

## Security & secrets

- No secrets, tokens, or private keys in the repo. Read them from env / a secret store.
- Encrypt profile blobs (cookies/storage) at rest (AES) and in transit (HTTPS).
- Validate/parse all external input (proxy strings, API bodies) at the boundary.

## Comments

- Explain **why**, not **what**. Document the coherence/stealth intent of fingerprint code and any
  place a later day/phase fleshes out a stub (`// Day N: ...`, `// Phase 2: ...`).
