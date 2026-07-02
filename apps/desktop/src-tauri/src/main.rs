// Prevent an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Thin platform entrypoint. All real wiring lives in the library crate so it can be
// shared with test harnesses and (later) the mobile shells. See src/lib.rs.
fn main() {
    lobster_desktop_lib::run();
}
