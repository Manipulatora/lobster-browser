//! `Preferences`: an allowlist of UNTRACKED keys, merged on restore.
//!
//! ## Why an allowlist of untracked keys, and not the file
//!
//! `Default/Preferences` carries real user state — site permissions, zoom, language — but it is also
//! where Chromium's protected-preference machinery lives. `GetSettingsEnforcementGroup()` returns
//! `GROUP_ENFORCE_DEFAULT` on Windows and macOS (and `GROUP_NO_ENFORCEMENT` elsewhere), so on the two
//! platforms this product ships to, writing a TRACKED key without also recomputing its MAC in
//! `Secure Preferences` makes Chromium treat the profile as tampered: it resets the key, stamps
//! `prefs.preference_reset_time`, and can take the whole search/homepage/extension-list set with it.
//! `Secure Preferences` is therefore never captured and never written, and no key in
//! [`KTRACKED_PREFS`] may be written even if a manifest asks for it.
//!
//! ## Why merge instead of replace
//!
//! The target profile's `Preferences` holds live launcher state (the Lobee extension entry, window
//! placement, the profile's own name). Replacing the file would drop all of it; merging the
//! allowlisted subtrees in and letting Chromium recompute its own MACs on next write leaves
//! everything else exactly as the launcher left it.
//!
//! `default_search_provider_data.template_url_data` is deliberately NOT allowlisted even though it
//! is user state: excluding it deletes the protected-pref-MAC question entirely rather than answering
//! it.

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde_json::{Map, Value};

/// `kTrackedPrefs` from `chrome/browser/prefs/chrome_pref_service_factory.cc`, mirrored by hand with
/// each identifier resolved to its literal pref path.
///
/// This list is a CONTRACT with the pinned fork, not a convenience. It exists so that writing a
/// tracked key is impossible by construction, and [`tests::tracked_prefs_cover_the_forks_list`]
/// fails the build if the mirror and the fork diverge. Reporting ids are kept in the comments so an
/// upstream append is easy to spot.
pub const KTRACKED_PREFS: &[&str] = &[
    "browser.show_home_button",                       // 0  kShowHomeButton
    "homepage_is_newtabpage",                         // 1  kHomePageIsNewTabPage
    "homepage",                                       // 2  kHomePage
    "session.restore_on_startup",                     // 3  kRestoreOnStartup
    "session.startup_urls",                           // 4  kURLsToRestoreOnStartup
    "extensions.settings",                            // 5  extensions::pref_names::kExtensions
    "google.services.last_username",                  // 6  kGoogleServicesLastSyncingUsername
    "search_provider_overrides",                      // 7  kSearchProviderOverrides
    "pinned_tabs",                                    // 11 kPinnedTabs
    "default_search_provider_data.template_url_data", // 14 kDefaultSearchProviderDataPrefName
    "prefs.preference_reset_time",                    // 15 kPreferenceResetTime
    "safebrowsing.incidents_sent",                    // 18 kSafeBrowsingIncidentsSent
    "google.services.account_id",                     // 23 kGoogleServicesAccountId
    "media.storage_id_salt",                          // 29 kMediaStorageIdSalt
    "media.cdm.origin_data",                          // 32 kMediaCdmOriginData (Windows)
    "google.services.last_signed_in_username",        // 33 kGoogleServicesLastSignedInUsername
    "enterprise_signin.policy_recovery_token",        // 34 kPolicyRecoveryToken
    "extensions.ui.developer_mode",                   // 35 kExtensionsUIDeveloperMode
    "schedule_to_flush_to_disk",                      // 36 kScheduleToFlushToDisk
    "extensions.install.initiallist",                 // 37 kInitialInstallList
    "extensions.install.initialprovidername",         // 38 kInitialInstallProviderName
];

/// What may travel. Every entry is a dotted path naming a subtree; `intl` carries both
/// `accept_languages` and `selected_languages` without enumerating them.
///
/// Not here, on purpose: `homepage`, `pinned_tabs`, anything under `session.`, `extensions.settings`
/// (all tracked), and `default_search_provider_data` (see the module note).
pub const PREFS_ALLOWLIST: &[&str] = &[
    "profile.content_settings.exceptions",
    "profile.default_content_setting_values",
    "profile.per_host_zoom_levels",
    "partition.default_zoom_level",
    "intl",
];

/// Top-level key prefixes that travel wholesale. Chromium spreads translate state across several
/// sibling top-level keys (`translate_blocked_languages`, `translate_site_blocklist`,
/// `translate_recent_target`, …) and adds more between releases, so a prefix is more durable than an
/// enumeration — and none of them is tracked.
pub const PREFS_ALLOWED_PREFIXES: &[&str] = &["translate_"];

/// Pull the allowlisted subset out of a `Preferences` document.
///
/// A missing key is normal: `partition` and every `translate_*` key are absent from all nine real
/// profiles on this machine.
pub fn extract(preferences: &Value) -> Result<Value> {
    let mut out = Map::new();
    for path in PREFS_ALLOWLIST {
        assert_untracked(path)?;
        if let Some(value) = get_path(preferences, path) {
            set_path(&mut out, path, value.clone());
        }
    }
    if let Some(obj) = preferences.as_object() {
        // BTreeMap ordering inside serde_json's default `Map` keeps this deterministic; if the crate
        // is ever built with the `preserve_order` feature this becomes insertion order, which is why
        // the keys are collected and sorted rather than taken as iterated.
        let mut prefixed: Vec<&String> = obj
            .keys()
            .filter(|k| PREFS_ALLOWED_PREFIXES.iter().any(|p| k.starts_with(p)))
            .collect();
        prefixed.sort();
        for key in prefixed {
            assert_untracked(key)?;
            out.insert(key.clone(), obj[key].clone());
        }
    }
    Ok(Value::Object(out))
}

/// Merge a captured subset into the target's own `Preferences`, refusing any tracked key.
///
/// Merge semantics are per-leaf: a captured object is merged key by key into an existing object, so a
/// content-setting exception the target already has for a site the snapshot does not know about
/// survives. Anything that is not an object replaces wholesale — a captured `intl.accept_languages`
/// string is a single value, not something to union.
pub fn merge(target: &mut Value, subset: &Value) -> Result<Vec<String>> {
    let mut applied = Vec::new();
    let Some(subset_obj) = subset.as_object() else {
        bail!("prefs subset is not a JSON object");
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    for (key, value) in subset_obj {
        merge_into(target, key, value, key, &mut applied)?;
    }
    applied.sort();
    Ok(applied)
}

fn merge_into(
    target: &mut Value,
    key: &str,
    value: &Value,
    path: &str,
    applied: &mut Vec<String>,
) -> Result<()> {
    assert_untracked(path)?;
    let target_obj = target
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("cannot merge `{path}` into a non-object"))?;
    match value {
        Value::Object(children) => {
            let slot = target_obj
                .entry(key.to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !slot.is_object() {
                *slot = Value::Object(Map::new());
            }
            for (child_key, child_value) in children {
                merge_into(
                    slot,
                    child_key,
                    child_value,
                    &format!("{path}.{child_key}"),
                    applied,
                )?;
            }
        }
        _ => {
            target_obj.insert(key.to_string(), value.clone());
            applied.push(path.to_string());
        }
    }
    Ok(())
}

/// Refuse a path that is, or is nested under, a tracked pref.
///
/// The prefix test is what stops `extensions.settings.<id>.state` — a path that is not literally in
/// the list but sits under a `SPLIT`-strategy tracked pref, where each child has its own MAC.
fn assert_untracked(path: &str) -> Result<()> {
    for tracked in KTRACKED_PREFS {
        if path == *tracked || path.starts_with(&format!("{tracked}.")) {
            bail!(
                "TRACKED_PREF_REFUSED: `{path}` is (or is under) the tracked preference `{tracked}`. \
                 Writing it without recomputing its MAC in Secure Preferences makes Chromium reset \
                 the preference on Windows and macOS and stamp prefs.preference_reset_time."
            );
        }
    }
    Ok(())
}

fn get_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cursor = value;
    for part in path.split('.') {
        cursor = cursor.as_object()?.get(part)?;
    }
    Some(cursor)
}

fn set_path(out: &mut Map<String, Value>, path: &str, value: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut cursor = out;
    for part in &parts[..parts.len() - 1] {
        cursor = cursor
            .entry((*part).to_string())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .expect("just inserted an object");
    }
    cursor.insert(parts[parts.len() - 1].to_string(), value);
}

/// Read a `Preferences` file. Chromium's own corruption guard permanently skips a file it cannot
/// parse and silently falls back to defaults, so a parse failure here has to be reported, not
/// swallowed into an empty subset.
pub fn read_file(path: &Path) -> Result<Value> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parsing {} as JSON", path.display()))
}

/// Write a `Preferences` file the way Chromium's own `ImportantFileWriter` does: temp file, fsync,
/// rename. A crash mid-write must never truncate the real file — a truncated `Preferences` trips the
/// corruption guard, after which every site permission, zoom level and language setting is gone.
pub fn write_file_atomic(path: &Path, value: &Value) -> Result<()> {
    let tmp = path.with_extension("lobster-tmp");
    let serialized = serde_json::to_vec(value)?;
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp)?;
        use std::io::Write;
        file.write_all(&serialized)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Guards the `float_roundtrip` feature on serde_json, which the tracked prefs depend on.
    ///
    /// WITHOUT that feature serde_json's parser is off by up to 1 ULP on a 17-significant-digit
    /// literal and then re-emits the shorter form: a real profile's `site_engagement` scores drifted
    /// 9.299999999999999 -> 9.3 and 14.999999999999995 -> 14.999999999999996 through a capture and
    /// restore. `partition.default_zoom_level` and `profile.per_host_zoom_levels` are floats on the
    /// tracked list too, so this is the user's live Preferences being rewritten with values they did
    /// not set. The read-back check cannot catch it — capture and re-extract share the same parser,
    /// so both sides drift identically and agree. Only an exact-text assertion catches it, which is
    /// why this test compares STRINGS and not f64s.
    #[test]
    fn tracked_float_prefs_survive_a_round_trip_bit_exactly() {
        // Plain decimal literals: the text must come back byte-identical, because for these the only
        // way the text can change is the value changing.
        for raw in [
            "9.299999999999999",
            "14.999999999999995",
            "-0.30000000000000004",
            "1.2000000000000002",
        ] {
            let parsed: Value = serde_json::from_str(raw).expect("parses");
            assert_eq!(
                serde_json::to_string(&parsed).unwrap(),
                raw,
                "serde_json altered {raw} — is the `float_roundtrip` feature still enabled in Cargo.toml?"
            );
        }

        // Exponent form is asserted on the VALUE, not the text: serde_json normalises `e308` to
        // `e+308`, which is a spelling change and not a loss. Comparing text here would fail for a
        // reason that does not matter and would train the next person to delete the test.
        for raw in ["1.7976931348623157e308", "5e-324"] {
            let parsed: Value = serde_json::from_str(raw).expect("parses");
            let reparsed: Value =
                serde_json::from_str(&serde_json::to_string(&parsed).unwrap()).expect("re-parses");
            assert_eq!(
                parsed.as_f64().unwrap().to_bits(),
                reparsed.as_f64().unwrap().to_bits(),
                "{raw} did not survive as the same f64"
            );
        }

        // And the same through the real extract/merge path, not just the parser in isolation.
        let mut source = real_shaped_preferences();
        source["profile"]["per_host_zoom_levels"] = json!({ "example.com": 1.2000000000000002 });
        let text = serde_json::to_string(&source).unwrap();
        let reparsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            serde_json::to_string(&reparsed["profile"]["per_host_zoom_levels"]).unwrap(),
            r#"{"example.com":1.2000000000000002}"#
        );
    }

    /// Shaped after the real `prf_c30fea6b/Default/Preferences`: 40 KB of state whose tracked keys
    /// sit right beside the ones we want.
    fn real_shaped_preferences() -> Value {
        json!({
            "profile": {
                "name": "Persona 4",
                "content_settings": {
                    "pref_version": 1,
                    "exceptions": {
                        "media_engagement": { "https://1procard.com,*": { "setting": 1 } },
                        "site_engagement": { "https://payoneer.com,*": { "setting": 2 } },
                        "notifications": {}
                    }
                },
                "default_content_setting_values": { "has_migrated_local_network_access": true },
                "exit_type": "Normal"
            },
            "intl": { "accept_languages": "en-US,en", "selected_languages": "en-US,en" },
            "session": { "restore_on_startup": 1 },
            "extensions": {
                "settings": { "opbicdcjjlpehmibpmkmkconpnnkijel": { "state": 1 } },
                "pinned_extensions": ["opbicdcjjlpehmibpmkmkconpnnkijel"]
            },
            "homepage": "https://example.test",
            "pinned_tabs": [],
            "schedule_to_flush_to_disk": "13430898126032860",
            "translate_site_blocklist": ["example.test"],
            "browser": { "window_placement": { "maximized": true } }
        })
    }

    #[test]
    fn extract_takes_the_allowlist_and_nothing_else() {
        let subset = extract(&real_shaped_preferences()).unwrap();
        assert_eq!(
            subset["profile"]["content_settings"]["exceptions"]["site_engagement"]
                ["https://payoneer.com,*"]["setting"],
            json!(2)
        );
        assert_eq!(subset["intl"]["accept_languages"], json!("en-US,en"));
        assert_eq!(subset["translate_site_blocklist"], json!(["example.test"]));

        // Everything tracked, and everything simply not allowlisted, must be absent.
        let obj = subset.as_object().unwrap();
        assert!(!obj.contains_key("session"));
        assert!(!obj.contains_key("extensions"));
        assert!(!obj.contains_key("homepage"));
        assert!(!obj.contains_key("pinned_tabs"));
        assert!(!obj.contains_key("schedule_to_flush_to_disk"));
        assert!(!obj.contains_key("browser"));
        // `pref_version` and `exit_type` sit next to allowlisted keys and are not carried.
        assert!(subset["profile"]["content_settings"]
            .as_object()
            .unwrap()
            .get("pref_version")
            .is_none());
        assert!(subset["profile"].as_object().unwrap().get("name").is_none());
        assert!(subset["profile"]
            .as_object()
            .unwrap()
            .get("exit_type")
            .is_none());
    }

    #[test]
    fn merge_preserves_target_state_and_adds_the_snapshots() {
        let subset = extract(&real_shaped_preferences()).unwrap();
        // A freshly launched target: the launcher has already written its own extension entry and the
        // profile has one permission of its own.
        let mut target = json!({
            "profile": {
                "name": "restored",
                "content_settings": { "exceptions": {
                    "geolocation": { "https://maps.test,*": { "setting": 1 } }
                }}
            },
            "extensions": { "settings": { "lobee": { "state": 1 } } },
            "session": { "restore_on_startup": 4 }
        });
        let applied = merge(&mut target, &subset).unwrap();

        assert_eq!(
            target["profile"]["name"],
            json!("restored"),
            "target state kept"
        );
        assert_eq!(
            target["extensions"]["settings"]["lobee"]["state"],
            json!(1),
            "launcher's extension entry untouched"
        );
        assert_eq!(
            target["session"]["restore_on_startup"],
            json!(4),
            "tracked key untouched"
        );
        assert_eq!(
            target["profile"]["content_settings"]["exceptions"]["geolocation"]
                ["https://maps.test,*"]["setting"],
            json!(1),
            "the target's own exception survives the merge"
        );
        assert_eq!(
            target["profile"]["content_settings"]["exceptions"]["site_engagement"]
                ["https://payoneer.com,*"]["setting"],
            json!(2),
            "the snapshot's exception lands"
        );
        assert!(applied.iter().any(|p| p.starts_with("intl.")));
        assert!(applied
            .iter()
            .all(|p| !p.starts_with("session.") && !p.starts_with("extensions.")));
    }

    /// The refusal is what makes the allowlist a mechanism rather than a convention: a manifest
    /// written by a future build, or hand-edited, must still not be able to reset a user's search
    /// engine.
    #[test]
    fn merging_a_subset_that_names_a_tracked_pref_is_refused() {
        let mut target = json!({});
        for tracked in [
            "session.restore_on_startup",
            "homepage",
            "extensions.settings",
            "prefs.preference_reset_time",
            "default_search_provider_data.template_url_data",
        ] {
            let mut subset = json!({});
            let parts: Vec<&str> = tracked.split('.').collect();
            set_path(subset.as_object_mut().unwrap(), tracked, json!("hostile"));
            let err = merge(&mut target, &subset).unwrap_err().to_string();
            assert!(
                err.contains("TRACKED_PREF_REFUSED"),
                "{tracked} ({parts:?}) was not refused: {err}"
            );
        }
        // And a child of a SPLIT-strategy tracked pref, which is not literally in the list.
        let mut subset = json!({});
        set_path(
            subset.as_object_mut().unwrap(),
            "extensions.settings.abc.state",
            json!(0),
        );
        assert!(merge(&mut target, &subset)
            .unwrap_err()
            .to_string()
            .contains("TRACKED_PREF_REFUSED"));
    }

    #[test]
    fn no_allowlist_entry_is_a_tracked_pref() {
        for path in PREFS_ALLOWLIST {
            assert_untracked(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        }
        for prefix in PREFS_ALLOWED_PREFIXES {
            for tracked in KTRACKED_PREFS {
                assert!(
                    !tracked.starts_with(prefix),
                    "prefix `{prefix}` would capture tracked pref `{tracked}`"
                );
            }
        }
    }

    /// DRIFT GUARD. The mirror above is only useful if it stays equal to the fork's list. This
    /// compares against the pinned checkout when it is present, and is skipped (not failed) when it
    /// is not, so the desktop suite still runs on a machine without the engine source. The blocking
    /// version of this check belongs in CI, where the checkout is guaranteed.
    #[test]
    fn tracked_prefs_cover_the_forks_list() {
        let Some(checkout) =
            std::env::var_os("LOBIUM_CHROMIUM_SRC").or_else(|| std::env::var_os("CHROMIUM_SRC"))
        else {
            eprintln!(
                "skipping tracked-pref drift check: set LOBIUM_CHROMIUM_SRC to a Chromium checkout"
            );
            return;
        };
        let source =
            Path::new(&checkout).join("chrome/browser/prefs/chrome_pref_service_factory.cc");
        let Ok(text) = std::fs::read_to_string(&source) else {
            eprintln!(
                "skipping tracked-pref drift check: {} not present",
                source.display()
            );
            return;
        };
        let start = text
            .find("const auto kTrackedPrefs")
            .expect("kTrackedPrefs array");
        let end = text[start..]
            .find("kTrackedPrefsReportingIDsCount")
            .expect("end of kTrackedPrefs array")
            + start;
        let block = &text[start..end];
        // Each entry is `{<id>, <identifier>, EnforcementLevel::…`. Counting entries catches an
        // upstream append even when we cannot resolve the new identifier to a literal here.
        let entries = block.matches("EnforcementLevel::").count();
        assert_eq!(
            entries,
            KTRACKED_PREFS.len(),
            "the fork's kTrackedPrefs has {entries} entries but this mirror has {}. Resolve the new \
             identifier(s) to their pref path literals and add them to KTRACKED_PREFS — until then a \
             newly-tracked preference can be written by a restore, which resets it on Windows/macOS.",
            KTRACKED_PREFS.len()
        );
    }

    #[test]
    fn atomic_write_leaves_no_temp_file_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("lobster-prefs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Preferences");
        let value = real_shaped_preferences();
        write_file_atomic(&path, &value).unwrap();
        assert!(!dir.join("Preferences.lobster-tmp").exists());
        assert_eq!(read_file(&path).unwrap(), value);

        // A file that is not JSON must fail loudly: Chromium's own guard would silently fall back to
        // defaults, losing every site permission in it.
        std::fs::write(&path, b"{not json").unwrap();
        assert!(read_file(&path).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
