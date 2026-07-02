// Tauri build script: parses tauri.conf.json, embeds capabilities + frontend assets,
// and generates the code consumed by `tauri::generate_context!()` in src/lib.rs.
fn main() {
    tauri_build::build();
}
