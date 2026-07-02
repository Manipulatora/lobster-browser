# T-001 — Tauri shell boots + loads React UI shell

- **Pillar/Track:** A · Desktop Core
- **Assignee:** Codex
- **Status:** ready
- **Depends on:** T-006 (workspace wiring), Rust toolchain installed

## Goal

Get the Day 0 desktop scaffold actually building and running: the Tauri window opens, loads the React
UI shell, and the local automation API answers `GET /api/v1/health`.

## Spec

- Install the Rust toolchain (`rustup`, pinned by `rust-toolchain.toml`).
- `npm run tauri dev` opens the window and renders the React dashboard shell (sidebar + main pane).
- The Axum local API serves `/api/v1/health` on `127.0.0.1:53211`.
- SQLite profile store initializes its schema on first launch (`profile_store::init`).

## Files to touch

- `apps/desktop/**` (fix any scaffold gaps), `apps/desktop/src-tauri/**`.

## Acceptance criteria

- Window opens; `invoke('app_version')` renders the version in the UI.
- `curl 127.0.0.1:53211/api/v1/health` → `{"code":0,...}`.
- `cargo fmt --check` and `cargo clippy -- -D warnings` clean.

## Test requirements

- A Rust unit test for the health handler returning the correct envelope.
