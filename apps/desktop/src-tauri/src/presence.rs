//! Presence: which machine is running which profile, as the account sees it.
//!
//! The backend has had profile leases since migration 0010 — acquire, refresh, release, and a
//! per-profile "who holds it" read — and no shipped launcher ever wrote one. So the account never
//! knew a profile was open, a second machine saw every profile as idle, and the owner's question
//! "which profile is running, which proxy is in use?" had no answer across machines.
//!
//! This module is the launcher's side of it: a stable per-install device identity, a lease taken
//! when a profile starts and refreshed while it runs and released when it stops, and a periodic
//! read of every live lease the account can see, merged into the profile list as `presence`.
//!
//! Leases are ADVISORY here. A launch is never refused because another machine holds the lease:
//! the profile's data is this machine's own copy, and refusing would turn a crashed machine's stale
//! claim (150 s until it expires) into a locked-out user. The UI says who holds it; the person
//! decides.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tauri::Manager;

/// How often a held lease is renewed. The server's TTL is 150 s; renewing at 60 s survives one
/// missed renewal.
const REFRESH_INTERVAL: Duration = Duration::from_secs(60);
/// How often the account's presence view is read while signed in.
const POLL_INTERVAL: Duration = Duration::from_secs(20);

/// What the profile list shows beside a profile another (or this) machine is running.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePresence {
    pub device_id: String,
    pub device_label: String,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mine: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseDto {
    profile_id: String,
    lease_id: String,
    device_id: String,
    device_label: String,
    expires_at: String,
}

#[derive(Debug, Clone)]
struct Held {
    remote_id: String,
    lease_id: String,
}

pub struct Presence {
    pub device_id: String,
    pub device_label: String,
    /// Leases this machine holds, by LOCAL profile id.
    held: Mutex<HashMap<String, Held>>,
    /// Every live lease the account reported at the last poll, by REMOTE profile id.
    seen: Mutex<HashMap<String, ProfilePresence>>,
}

impl Presence {
    /// Load or mint this install's identity. The id lives in a small file beside the profiles
    /// directory, so it survives sign-out and reinstalls that keep the data directory, and the
    /// label is the machine's hostname — what a person recognises in "running on …".
    pub fn new(data_dir: &Path) -> Self {
        Self {
            device_id: load_or_create_device_id(data_dir),
            device_label: machine_label(),
            held: Mutex::new(HashMap::new()),
            seen: Mutex::new(HashMap::new()),
        }
    }

    /// The presence to show for a profile, given the account's id for it.
    pub fn presence_for(&self, remote_id: &str) -> Option<ProfilePresence> {
        let seen = self.seen.lock().ok()?;
        let mut presence = seen.get(remote_id)?.clone();
        presence.mine = Some(presence.device_id == self.device_id);
        Some(presence)
    }

    fn holds(&self, profile_id: &str) -> Option<Held> {
        self.held.lock().ok()?.get(profile_id).cloned()
    }

    fn replace_seen(&self, leases: Vec<LeaseDto>) {
        if let Ok(mut seen) = self.seen.lock() {
            seen.clear();
            for lease in leases {
                seen.insert(
                    lease.profile_id,
                    ProfilePresence {
                        device_id: lease.device_id,
                        device_label: lease.device_label,
                        expires_at: lease.expires_at,
                        mine: None,
                    },
                );
            }
        }
    }
}

fn load_or_create_device_id(data_dir: &Path) -> String {
    let path = data_dir.join("device-id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() && trimmed.len() <= 128 {
            return trimmed.to_string();
        }
    }
    let fresh = uuid::Uuid::new_v4().to_string();
    if let Err(err) = std::fs::write(&path, &fresh) {
        tracing::warn!(error = %err, path = %path.display(), "could not persist the device id");
    }
    fresh
}

fn machine_label() -> String {
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(var) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return clamp_label(value);
            }
        }
    }
    if let Ok(value) = std::fs::read_to_string("/etc/hostname") {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return clamp_label(value);
        }
    }
    "This machine".to_string()
}

fn clamp_label(value: String) -> String {
    value.chars().take(64).collect()
}

fn remote_id_of(state: &crate::AppState, profile_id: &str) -> Result<Option<String>> {
    let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
    Ok(crate::profile_store::sync_link(&conn, profile_id)
        .map_err(|e| anyhow!("{e}"))?
        .and_then(|link| link.remote_id))
}

fn still_running(state: &crate::AppState, profile_id: &str) -> bool {
    let Ok(conn) = state.db.lock() else {
        return false;
    };
    crate::profile_store::get(&conn, &state.cipher, profile_id)
        .ok()
        .flatten()
        .is_some_and(|profile| profile.status == "running" || profile.status == "launching")
}

/// Take the profile's lease for this machine and keep it renewed while the profile runs.
/// Fire-and-forget: a launch never waits on the network, and a failure here is a log line.
pub fn spawn_acquire(app: tauri::AppHandle, profile_id: String) {
    tauri::async_runtime::spawn(async move {
        if !crate::profile_sync::signed_in() {
            return;
        }
        let state = app.state::<crate::AppState>();
        let remote_id = match remote_id_of(&state, &profile_id) {
            Ok(Some(id)) => id,
            Ok(None) => return, // never synced: the account does not know this profile
            Err(err) => {
                tracing::warn!(error = %format!("{err:#}"), "presence: could not resolve the account id");
                return;
            }
        };
        let body = serde_json::json!({
            "deviceId": state.presence.device_id,
            "deviceLabel": state.presence.device_label,
        });
        let path = format!("/profiles/{remote_id}/lease");
        let lease: LeaseDto = match crate::profile_sync::api_call(
            reqwest::Method::POST,
            &path,
            Some(body),
        )
        .await
        {
            Ok(lease) => lease,
            Err(err) => {
                // Held elsewhere (409) or unreachable: say so once and carry on — the launch
                // already happened, and the presence poll will show who holds it.
                tracing::info!(profile_id, error = %format!("{err:#}"), "presence: lease not taken");
                return;
            }
        };
        if let Ok(mut held) = state.presence.held.lock() {
            held.insert(
                profile_id.clone(),
                Held {
                    remote_id: remote_id.clone(),
                    lease_id: lease.lease_id.clone(),
                },
            );
        }
        tracing::info!(profile_id, "presence: lease taken");

        loop {
            tokio::time::sleep(REFRESH_INTERVAL).await;
            let Some(held) = state.presence.holds(&profile_id) else {
                return; // released
            };
            if !still_running(&state, &profile_id) {
                release_now(&state, &profile_id, &held).await;
                return;
            }
            let refresh = format!("/profiles/{}/lease/refresh", held.remote_id);
            let body = serde_json::json!({ "leaseId": held.lease_id });
            if let Err(err) = crate::profile_sync::api_call::<serde::de::IgnoredAny>(
                reqwest::Method::POST,
                &refresh,
                Some(body),
            )
            .await
            {
                // Taken over or expired: it is not ours any more. Stop renewing; the poll shows
                // the real holder.
                tracing::warn!(profile_id, error = %format!("{err:#}"), "presence: lease renewal failed");
                if let Ok(mut held) = state.presence.held.lock() {
                    held.remove(&profile_id);
                }
                return;
            }
        }
    });
}

/// Give the lease back the moment the profile stops, so another machine sees it free at once
/// rather than after the TTL.
pub fn spawn_release(app: tauri::AppHandle, profile_id: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<crate::AppState>();
        let Some(held) = state.presence.holds(&profile_id) else {
            return;
        };
        release_now(&state, &profile_id, &held).await;
    });
}

async fn release_now(state: &crate::AppState, profile_id: &str, held: &Held) {
    if let Ok(mut map) = state.presence.held.lock() {
        map.remove(profile_id);
    }
    let path = format!("/profiles/{}/lease", held.remote_id);
    let body = serde_json::json!({ "leaseId": held.lease_id });
    if let Err(err) = crate::profile_sync::api_call::<serde::de::IgnoredAny>(
        reqwest::Method::DELETE,
        &path,
        Some(body),
    )
    .await
    {
        tracing::info!(profile_id, error = %format!("{err:#}"), "presence: release did not reach the account");
    }
    if let Ok(mut seen) = state.presence.seen.lock() {
        seen.remove(&held.remote_id);
    }
}

/// Read the account's presence view on a timer while signed in. Cheap (one small GET), and what
/// makes "running on <machine>" appear on every other machine within a poll interval.
pub fn spawn_presence_poll(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        loop {
            if crate::profile_sync::signed_in() {
                let state = app.state::<crate::AppState>();
                match crate::profile_sync::api_call::<Vec<LeaseDto>>(
                    reqwest::Method::GET,
                    "/leases",
                    None,
                )
                .await
                {
                    Ok(leases) => state.presence.replace_seen(leases),
                    Err(err) => {
                        tracing::debug!(error = %format!("{err:#}"), "presence: view not read")
                    }
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_device_id_is_minted_once_and_then_stable() {
        let dir = std::env::temp_dir().join(format!("lobster-presence-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = Presence::new(&dir);
        let second = Presence::new(&dir);
        assert_eq!(
            first.device_id, second.device_id,
            "the id survives a restart"
        );
        assert_eq!(first.device_id.len(), 36, "a UUID");
        assert!(!first.device_label.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn presence_marks_this_machine_as_mine_and_others_as_not() {
        let dir = std::env::temp_dir().join(format!("lobster-presence-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let presence = Presence::new(&dir);
        presence.replace_seen(vec![
            LeaseDto {
                profile_id: "remote-a".into(),
                lease_id: "l1".into(),
                device_id: presence.device_id.clone(),
                device_label: "here".into(),
                expires_at: "2026-09-02T22:00:00Z".into(),
            },
            LeaseDto {
                profile_id: "remote-b".into(),
                lease_id: "l2".into(),
                device_id: "someone-else".into(),
                device_label: "Office PC".into(),
                expires_at: "2026-09-02T22:00:00Z".into(),
            },
        ]);
        assert_eq!(
            presence.presence_for("remote-a").and_then(|p| p.mine),
            Some(true)
        );
        let other = presence.presence_for("remote-b").unwrap();
        assert_eq!(other.mine, Some(false));
        assert_eq!(other.device_label, "Office PC");
        assert!(
            presence.presence_for("remote-c").is_none(),
            "no lease, no presence"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
