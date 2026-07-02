# T-010 — Lobster Kernel: build environment + first Chromium build

- **Pillar/Track:** F · Lobster Kernel
- **Assignee:** Claude
- **Status:** ready
- **Depends on:** a dedicated build machine / self-hosted CI (large disk, many cores)

## Goal

Stand up the kernel build pipeline and produce a first working Chromium build we can iterate on — the
foundation of the flagship engine ([ADR-0004](../adr/ADR-0004-lobster-kernel.md)).

## Spec

- Install `depot_tools`; `fetch chromium`; **pin an exact Chromium ref** in `kernel/build.sh`
  (`CHROMIUM_REF`) and record it.
- Implement the real pipeline in `kernel/build.sh --run`: `gclient sync` → `gn gen out/Lobster`
  (from `kernel/gn-args.gn.example`) → `autoninja -C out/Lobster chrome`.
- Enable `ccache`/reclient for tractable rebuild times; document build host requirements.
- Produce a runnable unbranded Chromium binary from `out/Lobster`.

## Files to touch

- `kernel/build.sh`, `kernel/gn-args.gn.example`, `kernel/README.md`.

## Acceptance criteria

- `kernel/build.sh --run` completes and yields a launchable `chrome` binary.
- The pinned ref + build host + timings are documented.

## Test requirements

- A smoke check that the built binary launches headless and prints its version.
