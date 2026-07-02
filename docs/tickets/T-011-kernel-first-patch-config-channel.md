# T-011 — Lobster Kernel: quilt series + first native patch + config channel POC

- **Pillar/Track:** F · Lobster Kernel
- **Assignee:** Claude
- **Status:** ready
- **Depends on:** T-010 (a working build)

## Goal

Prove the kernel is a real engine: a native patch that reads a per-profile fingerprint config and
changes an observable surface — the POC that unlocks the full 50+ param native roadmap.

## Spec

- Initialize the quilt patch series (`kernel/patches/series`) on top of the pinned ref.
- Add the **config channel** (per [`kernel/config-channel.md`](../../kernel/config-channel.md)): the
  kernel reads a per-profile fingerprint config (serialized from `@lobster/shared-types` `Fingerprint`)
  at launch — decide the mechanism (switch / env / IPC) and document it.
- First native patch: **navigator/UA-CH** — set `navigator.userAgent`/platform + Sec-CH-UA from the
  config, natively (no JS).
- Wire it end-to-end: the sidecar can launch the kernel with a profile config and the value is honored.

## Files to touch

- `kernel/patches/**`, `kernel/config-channel.md`, `packages/engine-runner` (add a kernel runner path).

## Acceptance criteria

- Launching the kernel with two different profile configs yields two different `navigator.userAgent`
  values, set **natively** (confirmed: no JS override present).
- The config round-trips from `@lobster/shared-types` → sidecar → kernel unchanged.

## Test requirements

- Integration test: launch kernel with config A and B → assert the reported UA matches each.
