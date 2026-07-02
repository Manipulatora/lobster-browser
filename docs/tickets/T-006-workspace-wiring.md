# T-006 — Add `apps/desktop` + `apps/backend` to root workspaces

- **Pillar/Track:** infra
- **Assignee:** Claude
- **Status:** ready

## Goal

Bring the two app scaffolds into the npm workspace so `@lobster/shared-types` resolves for them and a
single root `npm install` wires everything, without letting engine/browser downloads bloat install.

## Spec

- Add `"apps/desktop"` and `"apps/backend"` to the root `package.json` `workspaces` array (remove the
  Day 0 `//workspaces-note` once done).
- Ensure `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (and patchright/puppeteer equivalents) is documented for
  install; engines are fetched by `engines/download-engines.mjs`, not npm.
- Verify `npm install` succeeds and `npm run typecheck` runs across all workspaces.

## Files to touch

- root `package.json` (workspaces only).

## Acceptance criteria

- `npm install` completes without downloading browser binaries.
- `npm run typecheck --workspaces --if-present` runs for every package/app.

## Test requirements

- CI `build` job green with all workspaces present.
