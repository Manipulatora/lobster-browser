# T-010 — Lobium: build environment + first Chromium build

- **Pillar/Track:** F · Lobium
- **Assignee:** Claude
- **Status:** ready
- **Depends on:** a dedicated build machine / self-hosted CI (large disk, many cores)

## Goal

Stand up the Lobium build pipeline and produce a first working Chromium build we can iterate on — the
foundation of the flagship engine ([ADR-0004](../adr/ADR-0004-lobium.md)).

## Spec

- Install `depot_tools`; `fetch chromium`; **pin an exact Chromium ref** in `lobium/build.sh`
  (`CHROMIUM_REF`) and record it.
- Implement the real pipeline in `lobium/build.sh --run`: `gclient sync` → `gn gen out/Lobium`
  (from `lobium/gn-args.gn.example`) → `autoninja -C out/Lobium chrome`.
- Enable `ccache`/reclient for tractable rebuild times; document build host requirements.
- Produce a runnable unbranded Chromium binary from `out/Lobium`.

## Files to touch

- `lobium/build.sh`, `lobium/gn-args.gn.example`, `lobium/README.md`.

## Acceptance criteria

- `lobium/build.sh --run` completes and yields a launchable `chrome` binary.
- The pinned ref + build host + timings are documented.

## Test requirements

- A smoke check that the built binary launches headless and prints its version.
