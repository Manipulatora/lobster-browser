//! WAL-safe SQLite copying, and the liveness probe that says whether a quiesced capture is honest.
//!
//! ## Why not a file copy
//!
//! Every DOM-storage, IndexedDB, History and DIPS database in Lobium 152 is `journal_mode=wal`.
//! Copying the main file alone is silent data loss, and on real data it is total loss, not partial:
//! `prf_6d04dd17/Default/LocalStorage` is a 4096-byte main file against 28872 bytes of `-wal`, and
//! opened WITHOUT its `-wal` it has no tables at all — not an empty store, an uninitialised one.
//! Restoring that would hand Chromium a file it treats as brand new.
//!
//! ## Why `VACUUM INTO`
//!
//! It takes a read transaction, walks committed state with the WAL fully accounted for, and emits
//! ONE clean file with no sidecars. It never writes the source's USER DATA — though see the
//! read-write note below, which does mean a capture can touch the source's `-shm`/`-wal` sidecars.
//! The alternatives are worse:
//! `PRAGMA wal_checkpoint(TRUNCATE)` mutates a database another process may own and degrades to
//! PASSIVE under any concurrent reader (tearing the copy that follows), and copying main+`-wal`+`-shm`
//! as three separate files is not atomic — an interleaved checkpoint between the three reads
//! produces a set that does not belong to any point in time.
//!
//! ## Why the handle is READ-WRITE
//!
//! Deliberately, and this is the counter-intuitive part. A read-only handle cannot recover a WAL
//! whose `-shm` is missing or stale, which is precisely the crashed-browser case an offline capture
//! path exists to serve. SQLite needs write access to rebuild the shared-memory index before it can
//! read the WAL's committed frames at all. `VACUUM INTO` itself still only reads the source.
//!
//! The consequence, stated plainly because it is easy to describe this path as "read-only" and be
//! wrong: capturing a real profile MAY rewrite that profile's `-shm` and checkpoint its `-wal`. No
//! committed row changes and nothing is lost, but the live directory is not left byte-identical, so
//! this is not a side-effect-free operation on a profile another process owns. A concurrent writer
//! is handled by falling back to the page-stepping backup on BUSY rather than by forcing the issue.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use rusqlite::Connection;

/// Wait this long for a competing writer's transaction before falling back to the page-stepping
/// backup. Long enough to ride out a normal Chromium commit, short enough that a capture of 40
/// databases beside a busy browser does not stall the UI for a minute.
const BUSY_TIMEOUT: Duration = Duration::from_millis(2500);
/// Backup fallback: 512 pages per step, up to 20 steps, 250 ms between them.
const BACKUP_PAGES_PER_STEP: i32 = 512;
const BACKUP_MAX_STEPS: usize = 20;
const BACKUP_STEP_PAUSE: Duration = Duration::from_millis(250);

/// Sidecar suffixes that belong to a SQLite database and must move WITH it. A fresh main file left
/// beside a stale `-wal` is corruption: SQLite replays frames that describe pages the new file does
/// not have.
pub const SQLITE_SIDECARS: &[&str] = &["-wal", "-shm", "-journal"];

/// Copy `src` to `dst` with the WAL included. `dst` must not exist.
///
/// NOT IDEMPOTENT AT THE BYTE LEVEL, and nothing may be built on the assumption that it is. SQLite
/// writes `source_schema_cookie + 1` into the output header (bytes 40..44), so vacuuming a vacuum
/// output advances one byte with no change in content. Measured on a real 181-row cookie jar: the
/// original had schema cookie 3, the first copy 4, the second 5, and the two copies differed in
/// EXACTLY one byte at offset 43. Two consequences:
///
/// * the read-back verification on restore compares the bytes we WROTE, never a re-vacuum of them;
/// * a digest over a `VACUUM INTO` output cannot be used for "has this artifact changed?" or for
///   content-addressed dedup. Given identical input the output is identical (verified), so a digest is
///   still a valid integrity check — it is only useless as a change detector across captures.
pub fn vacuum_into(src: &Path, dst: &Path) -> Result<()> {
    if dst.exists() {
        bail!("vacuum target {} already exists", dst.display());
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = open_read_write(src)?;
    // `VACUUM INTO` takes an expression, so the destination binds as a parameter and never goes
    // through string interpolation into SQL.
    match conn.execute("VACUUM INTO ?1", [&dst.to_string_lossy()]) {
        Ok(_) => Ok(()),
        Err(err) if is_busy(&err) => {
            tracing::warn!(
                src = %src.display(),
                %err,
                "VACUUM INTO stayed busy; falling back to a page-stepping backup"
            );
            // VACUUM may have created and then abandoned the target.
            let _ = std::fs::remove_file(dst);
            backup_fallback(&conn, dst)
        }
        Err(err) => Err(anyhow::Error::new(err))
            .with_context(|| format!("VACUUM INTO from {}", src.display())),
    }
}

/// Page-stepping copy for a source whose writer will not yield. Slower and it holds a read lock
/// across pauses, but it makes progress under contention where a single-statement VACUUM cannot.
///
/// This produces a `-wal`-free file too: the backup API writes committed pages into a fresh
/// database, so there is nothing left in a journal to lose.
fn backup_fallback(conn: &Connection, dst: &Path) -> Result<()> {
    let mut target = Connection::open(dst)?;
    let backup = rusqlite::backup::Backup::new(conn, &mut target)?;
    for _ in 0..BACKUP_MAX_STEPS {
        match backup.step(BACKUP_PAGES_PER_STEP)? {
            rusqlite::backup::StepResult::Done => {
                drop(backup);
                target.close().map_err(|(_, e)| e)?;
                return Ok(());
            }
            rusqlite::backup::StepResult::Busy | rusqlite::backup::StepResult::Locked => {
                std::thread::sleep(BACKUP_STEP_PAUSE)
            }
            rusqlite::backup::StepResult::More => {}
            // `StepResult` is #[non_exhaustive]: a future variant we do not understand must abort the
            // copy rather than be read as progress, since the alternative is a silently short file.
            other => bail!("unexpected sqlite backup step result {other:?}"),
        }
    }
    drop(backup);
    let _ = target.close();
    let _ = std::fs::remove_file(dst);
    bail!(
        "backup of {} did not finish in {BACKUP_MAX_STEPS} steps; a writer is holding the database",
        dst.display()
    )
}

/// True for the two lock errors that mean "someone else is writing", as opposed to a real fault.
fn is_busy(err: &rusqlite::Error) -> bool {
    matches!(
        err.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy) | Some(rusqlite::ErrorCode::DatabaseLocked)
    )
}

/// Open read-write with a busy timeout. See the module note on why read-only is not an option.
pub fn open_read_write(path: &Path) -> Result<Connection> {
    if !path.exists() {
        bail!("sqlite source {} does not exist", path.display());
    }
    let conn = Connection::open(path)
        .with_context(|| format!("opening sqlite database {}", path.display()))?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(conn)
}

/// `PRAGMA integrity_check` on a staged file. Run before a staged database is allowed anywhere near
/// the live directory, so a truncated write fails at the gate instead of when Chromium opens it and
/// razes the store.
pub fn integrity_check(path: &Path) -> Result<()> {
    let conn = Connection::open(path)
        .with_context(|| format!("opening staged database {}", path.display()))?;
    let result: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .with_context(|| format!("integrity_check on {}", path.display()))?;
    if result != "ok" {
        bail!(
            "staged database {} failed integrity_check: {result}",
            path.display()
        );
    }
    Ok(())
}

/// Read `meta.version`, refusing a database written by a schema newer than we understand.
///
/// The asymmetry matters: Chromium migrates a database it considers old, but RAZES one whose
/// `last_compatible_version` exceeds what it supports. Writing a schema we do not understand is
/// therefore a way to destroy the very data we are restoring, so we refuse before writing rather
/// than discover it after.
pub fn meta_version(conn: &Connection, max_known: i64) -> Result<Option<i64>> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    let version: Option<i64> = conn
        .query_row("SELECT value FROM meta WHERE key='version'", [], |row| {
            row.get::<_, String>(0)
        })
        .ok()
        .and_then(|v| v.parse().ok());
    if let Some(v) = version {
        if v > max_known {
            bail!("database schema version {v} is newer than the {max_known} this build knows");
        }
    }
    Ok(version)
}

/// What the liveness probe found. `Unknown` is a distinct outcome on purpose: claiming "quiesced"
/// on evidence we could not actually test would put a false coherence label on the snapshot. Both
/// shipping desktop platforms now have a real pid probe (`/proc` on Linux, `OpenProcess` on
/// Windows), so `Unknown` is reserved for the genuinely unanswerable: a probe API failure, a lock
/// file we cannot parse, or a platform with no probe at all (macOS, a container without `/proc`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveOwner {
    None,
    /// A `SingletonLock` symlink naming a process that is still alive. Only the lock can produce
    /// this verdict: `DevToolsActivePort` carries a port, not a pid, so it cannot name an owner.
    Alive {
        detail: String,
    },
    Unknown {
        detail: String,
    },
}

/// Decide whether a user-data-dir is unowned, by reading the two files Chromium leaves behind.
///
/// `SingletonLock` is a symlink whose target is `hostname-pid`; `DevToolsActivePort` holds the CDP
/// port on its first line. Both are routinely STALE — that is the whole reason the launcher clears
/// `DevToolsActivePort` before spawning — so a file's existence proves nothing and only pid liveness
/// does. A stale leftover after a crash is the common case and must NOT block a capture, since the
/// crashed profile is exactly the one whose session the user needs out.
pub fn assert_no_live_owner(udd: &Path) -> Result<LiveOwner> {
    classify_owner(udd, &pid_is_alive, pid_liveness_available())
}

/// The decision logic behind [`assert_no_live_owner`], with the platform facts injected. Tests use
/// this to pin every verdict on every build platform: a blind platform is simulated on a sighted
/// one (and vice versa), and a dead or live pid needs no spawned fixture process.
fn classify_owner(
    udd: &Path,
    pid_is_alive: &dyn Fn(u32) -> Option<bool>,
    liveness_available: bool,
) -> Result<LiveOwner> {
    let lock = udd.join("SingletonLock");
    if let Some(verdict) = read_singleton_lock(&lock, pid_is_alive)? {
        return Ok(verdict);
    }
    // The lock says nobody owns the directory. `DevToolsActivePort` carries no pid — a CDP port and
    // a browser-target path — so there is nothing in it a pid probe could test, and Chromium leaves
    // it behind on EVERY unclean shutdown. On Windows, where the singleton is a named mutex we
    // cannot see rather than a lock file, that leftover is the only file this probe ever finds, and
    // treating bare presence as "maybe running" refused every post-crash export on the platform
    // (PROFILE_OWNER_UNKNOWN with nothing running — the reported field failure). A browser that IS
    // running on Windows is the sidecar's to report: it owns the child handle and knows liveness
    // authoritatively, where this filesystem probe is structurally blind. So presence alone
    // downgrades to Unknown only where the platform cannot test pid liveness AT ALL (macOS, a
    // container with `/proc` unmounted): there a leftover and a live owner really are
    // indistinguishable, and a false "quiesced" label is the worse lie. The stale file is
    // deliberately NOT deleted here: the launcher already clears it before every spawn, and a probe
    // that mutates the very directory it may be about to refuse to touch could no longer be run
    // speculatively.
    if udd.join("DevToolsActivePort").exists() && !liveness_available {
        return Ok(LiveOwner::Unknown {
            detail: "DevToolsActivePort is present and this platform cannot test pid liveness"
                .into(),
        });
    }
    Ok(LiveOwner::None)
}

/// `Some(verdict)` when the lock settles the question, `None` when it says nobody owns the dir.
fn read_singleton_lock(
    lock: &Path,
    pid_is_alive: &dyn Fn(u32) -> Option<bool>,
) -> Result<Option<LiveOwner>> {
    let target = match std::fs::read_link(lock) {
        Ok(target) => target.to_string_lossy().to_string(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Ok(Some(LiveOwner::Unknown {
                detail: "SingletonLock exists but is not a readable symlink".into(),
            }))
        }
    };
    Ok(classify_lock_target(&target, pid_is_alive))
}

/// The verdict for a `SingletonLock` target string, split from the symlink read because Chromium
/// writes this file on unix only: a Windows build meets one solely inside a directory restored from
/// a unix-taken capture, and a Windows TEST cannot create the symlink fixture at all (that needs a
/// privilege ordinary users and CI do not hold). The split lets both platforms pin the whole table.
///
/// `None` means "this lock names no live owner", mirroring [`read_singleton_lock`]'s contract.
fn classify_lock_target(
    target: &str,
    pid_is_alive: &dyn Fn(u32) -> Option<bool>,
) -> Option<LiveOwner> {
    let Some(pid) = parse_singleton_lock(target) else {
        return Some(LiveOwner::Unknown {
            detail: format!("SingletonLock -> {target} does not parse as hostname-pid"),
        });
    };
    match pid_is_alive(pid) {
        Some(true) => Some(LiveOwner::Alive {
            detail: format!("SingletonLock -> {target} (pid {pid} is running)"),
        }),
        Some(false) => None,
        None => Some(LiveOwner::Unknown {
            detail: format!("SingletonLock -> {target}; pid liveness unavailable"),
        }),
    }
}

/// `hostname-pid` → pid. The hostname half may itself contain `-`, so split from the RIGHT.
fn parse_singleton_lock(target: &str) -> Option<u32> {
    target.rsplit_once('-')?.1.parse().ok()
}

/// `Some(true|false)` when the platform can answer whether `pid` is running, `None` when it cannot.
/// `/proc` is the cheap answer: it needs no signal permission and shows every user's processes, so
/// the pid directory existing IS the verdict. macOS lands here too (`cfg(unix)`) but ships no
/// `/proc`, and [`pid_liveness_available`] reports that honestly rather than letting this return
/// `Some(false)` for every pid on a platform that never mounted the answer.
#[cfg(unix)]
fn pid_is_alive(pid: u32) -> Option<bool> {
    if !pid_liveness_available() {
        return None;
    }
    Some(PathBuf::from(format!("/proc/{pid}")).exists())
}

/// The Windows answer, from the process table itself. `OpenProcess` with
/// `PROCESS_QUERY_LIMITED_INFORMATION` — the weakest access right there is, grantable even on other
/// users' processes — resolves the pid against the kernel's table:
///
/// * `ERROR_INVALID_PARAMETER` is the documented "no such process object" answer → dead. This is
///   the branch that un-sticks the field failure: a `DevToolsActivePort` left behind by an unclean
///   shutdown used to freeze every export as `Unknown` because this function had no Windows arm.
/// * `ERROR_ACCESS_DENIED` proves the object EXISTS (the kernel found it, then refused the right)
///   → alive. This mirrors unix, where `/proc/<pid>` of a protected process still exists.
/// * A real handle is NOT yet proof of life: `OpenProcess` also succeeds on a terminated process
///   whose pid stays pinned by someone's open handle — and our own sidecar/job object holds exactly
///   such handles, so without `GetExitCodeProcess` a crashed engine would read as "running" until
///   the app exits. `STILL_ACTIVE` (259) is the canonical check, with the canonical caveat that a
///   live process which chose exit code 259 is indistinguishable from a dead one; nothing we spawn
///   does.
///
/// We deliberately do NOT verify the pid's image name (lobium/chrome). Unix does not either —
/// `/proc/<pid>` existence is its whole test — and the probe's contract has to stay "is this pid in
/// the process table" so both platforms answer identically for the same facts, and so the tests can
/// pin `Alive` with their own (non-browser) pid. The cost is pid reuse: a recycled pid behind a
/// leftover `SingletonLock` reads as Alive. That exposure is exactly the one unix has always
/// accepted, reaching it on Windows takes a unix-written lock file to begin with (see
/// [`classify_lock_target`]), and the `detail` names the pid so an operator can see precisely which
/// process blocked the capture.
#[cfg(windows)]
fn pid_is_alive(pid: u32) -> Option<bool> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: `OpenProcess` takes no pointers; it returns null or a handle this function owns and
    // closes on every path below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return match unsafe { GetLastError() } {
            ERROR_INVALID_PARAMETER => Some(false),
            ERROR_ACCESS_DENIED => Some(true),
            // Anything else is a genuine API failure. Guessing here is what `Unknown` exists to
            // avoid, and this is the only path left that produces it on Windows.
            _ => None,
        };
    }
    let mut exit_code: u32 = 0;
    // SAFETY: `handle` is a live process handle we own; `exit_code` outlives the call.
    let queried = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
    // SAFETY: closing the handle `OpenProcess` gave us, exactly once.
    unsafe { CloseHandle(handle) };
    if queried == 0 {
        return None;
    }
    Some(exit_code == STILL_ACTIVE as u32)
}

/// A target that is neither unix nor Windows has no probe wired up; saying so keeps the honest
/// `Unknown` path instead of inventing a verdict on a platform nobody has tested.
#[cfg(not(any(unix, windows)))]
fn pid_is_alive(_pid: u32) -> Option<bool> {
    None
}

/// True when this platform can decide whether a pid is running. Linux answers through `/proc` (a
/// container with `/proc` unmounted cannot answer, and we say so rather than guess). Windows
/// answers through `OpenProcess` — see [`pid_is_alive`] — so it is never platform-blind anymore: a
/// failed call over there is a per-pid `Unknown`, not a platform-wide shrug that used to turn every
/// leftover `DevToolsActivePort` into a refused export. macOS has no probe wired up yet and stays
/// conservatively blind.
fn pid_liveness_available() -> bool {
    #[cfg(unix)]
    {
        Path::new("/proc/self").exists()
    }
    #[cfg(windows)]
    {
        true
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

/// Move `path` and every SQLite sidecar it has into `dest_dir`, preserving the file name.
///
/// Returns the moves performed so the caller can undo them. Nothing is deleted: a restore that
/// fails after this point has to be able to put the original back, and `rm -rf` then untar is the
/// exact failure mode this design exists to avoid.
pub fn park_with_sidecars(path: &Path, dest_dir: &Path) -> Result<Vec<(PathBuf, PathBuf)>> {
    let mut moved = Vec::new();
    let name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("{} has no file name", path.display()))?;
    std::fs::create_dir_all(dest_dir)?;
    let mut candidates = vec![path.to_path_buf()];
    for suffix in SQLITE_SIDECARS {
        candidates.push(path.with_file_name(format!("{}{suffix}", name.to_string_lossy())));
    }
    for from in candidates {
        if !from.exists() {
            continue;
        }
        let to = dest_dir.join(from.file_name().expect("candidate has a file name"));
        std::fs::rename(&from, &to)
            .with_context(|| format!("parking {} -> {}", from.display(), to.display()))?;
        moved.push((from, to));
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lobster-snap-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Build the `prf_6d04dd17` shape on purpose: a WAL-mode database whose committed content is in
    /// the `-wal` and whose main file is a stub. This is the case a bare file copy loses entirely.
    ///
    /// The returned connection MUST be held for as long as the fixture is needed. SQLite checkpoints
    /// the WAL when the LAST connection closes, so a fixture that simply drops its writer merges the
    /// `-wal` away and stops reproducing the bug — the real profiles have an unmerged `-wal` precisely
    /// because the process holding it was killed. Holding a reader open reproduces that without
    /// killing anything.
    #[must_use]
    fn wal_db_with_unmerged_content(path: &Path) -> (Connection, u64, u64) {
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        conn.execute_batch(
            "CREATE TABLE tokens(k TEXT PRIMARY KEY, v BLOB NOT NULL);
             INSERT INTO tokens VALUES('auth', x'0102030405');
             INSERT INTO tokens VALUES('refresh', x'aabbccdd');",
        )
        .unwrap();
        let keep_alive = Connection::open(path).unwrap();
        keep_alive
            .query_row("SELECT count(*) FROM tokens", [], |r| r.get::<_, i64>(0))
            .unwrap();
        drop(conn);
        let main = std::fs::metadata(path).unwrap().len();
        let wal = std::fs::metadata(wal_path(path))
            .map(|m| m.len())
            .unwrap_or(0);
        (keep_alive, main, wal)
    }

    fn wal_path(path: &Path) -> PathBuf {
        path.with_file_name(format!(
            "{}-wal",
            path.file_name().unwrap().to_string_lossy()
        ))
    }

    #[test]
    fn vacuum_into_captures_wal_content_that_a_file_copy_loses() {
        let dir = temp_dir("wal");
        let src = dir.join("LocalStorage");
        let (_keep_alive, main_len, wal_len) = wal_db_with_unmerged_content(&src);
        assert!(
            wal_len > main_len,
            "fixture must reproduce the prf_6d04dd17 shape: main={main_len} wal={wal_len}"
        );

        // What a naive implementation does: copy the main database only.
        let naive = dir.join("naive.db");
        std::fs::copy(&src, &naive).unwrap();
        let naive_conn = Connection::open(&naive).unwrap();
        let naive_rows: i64 = naive_conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='tokens'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            naive_rows, 0,
            "the fixture is not exercising the WAL trap if the main file already has the table"
        );
        drop(naive_conn);

        let dst = dir.join("captured.db");
        vacuum_into(&src, &dst).unwrap();
        assert!(
            !wal_path(&dst).exists(),
            "VACUUM INTO must emit one file with no sidecars"
        );
        let conn = Connection::open(&dst).unwrap();
        let v: Vec<u8> = conn
            .query_row("SELECT v FROM tokens WHERE k='auth'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, vec![1, 2, 3, 4, 5]);
        let n: i64 = conn
            .query_row("SELECT count(*) FROM tokens", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
        drop(conn);
        integrity_check(&dst).unwrap();
        drop(_keep_alive);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn vacuum_into_never_mutates_the_source() {
        let dir = temp_dir("readonly");
        let src = dir.join("Cookies");
        let (_keep_alive, _, _) = wal_db_with_unmerged_content(&src);
        let read_all = || -> Vec<Vec<u8>> {
            ["", "-wal"]
                .iter()
                .map(|s| std::fs::read(dir.join(format!("Cookies{s}"))).unwrap_or_default())
                .collect()
        };
        let before = read_all();
        vacuum_into(&src, &dir.join("out.db")).unwrap();
        // The `-shm` is shared-memory scratch that SQLite rebuilds at will; only the durable pair is a
        // meaningful comparison.
        assert_eq!(before, read_all(), "VACUUM INTO changed the source");
        drop(_keep_alive);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Pins the schema-cookie behaviour documented on [`vacuum_into`], so a later change-detection or
    /// dedup feature built on "same content ⇒ same digest" fails here instead of in the field.
    #[test]
    fn vacuum_into_is_deterministic_per_input_but_advances_the_schema_cookie() {
        let dir = temp_dir("cookie");
        let src = dir.join("db");
        let (_keep_alive, _, _) = wal_db_with_unmerged_content(&src);

        let first = dir.join("first.db");
        let second = dir.join("second.db");
        let again = dir.join("again.db");
        vacuum_into(&src, &first).unwrap();
        vacuum_into(&first, &second).unwrap();
        vacuum_into(&first, &again).unwrap();

        let a = std::fs::read(&first).unwrap();
        let b = std::fs::read(&second).unwrap();
        assert_eq!(
            std::fs::read(&again).unwrap(),
            b,
            "the same input must produce the same output"
        );
        assert_eq!(a.len(), b.len());
        let differing: Vec<usize> = (0..a.len()).filter(|&i| a[i] != b[i]).collect();
        assert_eq!(
            differing,
            vec![43],
            "only the schema cookie's low byte may differ; got {differing:?}"
        );
        let cookie = |bytes: &[u8]| u32::from_be_bytes(bytes[40..44].try_into().unwrap());
        assert_eq!(cookie(&b), cookie(&a) + 1);
        drop(_keep_alive);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn integrity_check_rejects_a_truncated_staged_database() {
        let dir = temp_dir("truncated");
        let src = dir.join("db");
        let (_keep_alive, _, _) = wal_db_with_unmerged_content(&src);
        let staged = dir.join("staged.db");
        vacuum_into(&src, &staged).unwrap();
        integrity_check(&staged).unwrap();

        let bytes = std::fs::read(&staged).unwrap();
        std::fs::write(&staged, &bytes[..bytes.len() / 2]).unwrap();
        assert!(
            integrity_check(&staged).is_err(),
            "a half file must not pass the gate"
        );
        drop(_keep_alive);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn meta_version_refuses_a_schema_newer_than_we_know() {
        let dir = temp_dir("meta");
        let path = dir.join("Cookies");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
             INSERT INTO meta VALUES('version','24');",
        )
        .unwrap();
        assert_eq!(meta_version(&conn, 24).unwrap(), Some(24));
        conn.execute("UPDATE meta SET value='25' WHERE key='version'", [])
            .unwrap();
        assert!(meta_version(&conn, 24).is_err());
        // A database with no meta table at all is a legitimate shape (DOM storage before init).
        let bare = Connection::open(dir.join("bare")).unwrap();
        assert_eq!(meta_version(&bare, 24).unwrap(), None);
        drop(bare);
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn singleton_lock_parses_hostnames_that_contain_dashes() {
        assert_eq!(parse_singleton_lock("my-build-box-4242"), Some(4242));
        assert_eq!(parse_singleton_lock("host-1"), Some(1));
        assert_eq!(parse_singleton_lock("nodashes"), None);
        assert_eq!(parse_singleton_lock("host-notanumber"), None);
    }

    #[cfg(unix)]
    #[test]
    fn liveness_probe_distinguishes_stale_locks_from_live_owners() {
        let dir = temp_dir("owner");
        assert_eq!(assert_no_live_owner(&dir).unwrap(), LiveOwner::None);

        // A stale lock is the COMMON case after a crash and must not block a capture.
        let lock = dir.join("SingletonLock");
        std::os::unix::fs::symlink("somehost-4294967294", &lock).unwrap();
        assert_eq!(assert_no_live_owner(&dir).unwrap(), LiveOwner::None);

        std::fs::remove_file(&lock).unwrap();
        std::os::unix::fs::symlink(format!("somehost-{}", std::process::id()), &lock).unwrap();
        assert!(matches!(
            assert_no_live_owner(&dir).unwrap(),
            LiveOwner::Alive { .. }
        ));

        std::fs::remove_file(&lock).unwrap();
        std::os::unix::fs::symlink("somehost-not-a-pid-x", &lock).unwrap();
        assert!(matches!(
            assert_no_live_owner(&dir).unwrap(),
            LiveOwner::Unknown { .. }
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The reported field failure, pinned end to end: the browser crashed or was killed, Chromium
    /// left `DevToolsActivePort` behind, nothing is running — and export refused with
    /// PROFILE_OWNER_UNKNOWN because the platform "could not test pid liveness". On every platform
    /// with a real probe (Linux via `/proc`, Windows via `OpenProcess`) the leftover must be
    /// ignored — and left in place, because clearing it belongs to the launcher, not to a read-only
    /// probe that callers run speculatively.
    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn a_leftover_devtools_active_port_does_not_block_capture() {
        let dir = temp_dir("stale-port");
        std::fs::write(
            dir.join("DevToolsActivePort"),
            "39515\n/devtools/browser/2f2e6a9a-dead-beef\n",
        )
        .unwrap();
        assert_eq!(assert_no_live_owner(&dir).unwrap(), LiveOwner::None);
        assert!(
            dir.join("DevToolsActivePort").exists(),
            "the probe must not mutate the directory it inspects"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A platform with no pid probe at all (macOS, a `/proc`-less container) must keep refusing to
    /// call a port-file-bearing directory quiesced, and a platform WITH one must not. Injected, so
    /// both arms are pinned regardless of what the build machine itself can see.
    #[test]
    fn a_bare_port_file_downgrades_only_a_platform_that_cannot_probe_pids() {
        let dir = temp_dir("blind");
        std::fs::write(dir.join("DevToolsActivePort"), "1\n/devtools/browser/x\n").unwrap();
        // No lock exists, so the probe is never consulted; only `liveness_available` decides.
        let no_probe = |_pid: u32| -> Option<bool> { None };
        assert!(matches!(
            classify_owner(&dir, &no_probe, false).unwrap(),
            LiveOwner::Unknown { .. }
        ));
        assert_eq!(
            classify_owner(&dir, &no_probe, true).unwrap(),
            LiveOwner::None
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The lock-target verdict table, runnable on Windows too — where the symlink fixture cannot be
    /// created, which is exactly why `classify_lock_target` is split from the symlink read. The
    /// real probe pins alive/dead on the two platforms that have one; the injected probes pin the
    /// mapping itself everywhere.
    #[test]
    fn lock_targets_classify_by_pid_liveness_not_by_existence() {
        // Our own pid is the one pid guaranteed alive for the duration of the test.
        let ours = format!("build-box-{}", std::process::id());
        #[cfg(any(target_os = "linux", windows))]
        {
            assert!(matches!(
                classify_lock_target(&ours, &pid_is_alive),
                Some(LiveOwner::Alive { .. })
            ));
            assert_eq!(classify_lock_target("host-4294967294", &pid_is_alive), None);
        }
        // The mapping, independent of what this machine can actually see: dead → no owner,
        // probe failure → Unknown, unparseable → Unknown even when the probe would say alive.
        assert_eq!(classify_lock_target(&ours, &|_| Some(false)), None);
        assert!(matches!(
            classify_lock_target(&ours, &|_| None),
            Some(LiveOwner::Unknown { .. })
        ));
        assert!(matches!(
            classify_lock_target("host-not-a-pid", &|_| Some(true)),
            Some(LiveOwner::Unknown { .. })
        ));
    }

    /// The probe itself against the real OS. 4294967294 is allocatable on neither platform (Linux
    /// pids stop at `pid_max`, at most 2^22; Windows pids are multiples of 4, and 0xFFFF_FFFE is
    /// not), so `Some(false)` here exercises Windows' ERROR_INVALID_PARAMETER arm — the branch that
    /// turns a stale lock into "no owner" instead of a refused export.
    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn pid_probe_sees_our_own_process_and_not_a_never_allocated_pid() {
        assert_eq!(pid_is_alive(std::process::id()), Some(true));
        assert_eq!(pid_is_alive(0xFFFF_FFFE), Some(false));
    }

    #[test]
    fn parking_moves_the_sidecars_with_the_database() {
        let dir = temp_dir("park");
        let db = dir.join("LocalStorage");
        // This test exercises the filesystem transaction, not SQLite's WAL codec. Explicit sidecar
        // fixtures are deterministic and, unlike a live SQLite handle, remain renameable on Windows.
        std::fs::write(&db, b"main").unwrap();
        std::fs::write(dir.join("LocalStorage-wal"), b"wal").unwrap();
        std::fs::write(dir.join("LocalStorage-shm"), b"shm").unwrap();
        assert!(dir.join("LocalStorage-wal").exists());

        let parked = dir.join(".pre-restore");
        let moves = park_with_sidecars(&db, &parked).unwrap();
        assert!(!db.exists());
        assert!(!dir.join("LocalStorage-wal").exists(), "-wal left behind");
        assert!(parked.join("LocalStorage").exists());
        assert!(parked.join("LocalStorage-wal").exists());
        // Undoing the parking must restore the exact set.
        for (from, to) in moves.iter().rev() {
            std::fs::rename(to, from).unwrap();
        }
        assert!(db.exists() && dir.join("LocalStorage-wal").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
