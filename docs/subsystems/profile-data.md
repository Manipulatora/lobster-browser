# Per-profile browser data: persistence, portability and sync

STATUS: design accepted, Phase 0 in progress. This document is the contract for the work; it exists
because the audit that produced it found the feature to be 0% implemented on the client while the
product's sign-in screen told users their profiles were being synced.

## Status at a glance

Read this before the design below: parts of that design were superseded while building, and each
change is explained where it happened.

| Phase | State | What actually exists |
|---|---|---|
| 0 — Stop the bleeding | **Done** | Cookie import preserved; unreadable cells degrade instead of blanking the app; loopback API no longer serves live cookies or proxy passwords; nginx body limit; tombstones. |
| 1 — Platform CI | **Partly done** | `windows-latest` + `macos-latest` run typecheck, portable node:test suites, `cargo check`, and the snapshot round-trip **blocking** on both. The live logged-in round-trip still needs a self-hosted runner with a Lobium binary. |
| 2 — Local snapshot engine | **Done** | Capture / restore / verify with rollback, over the real artifact set. Proven on all 9 real profiles on the dev box. |
| 3 — Cross-OS portability | **Done (Linux-proven)** | 873/873 real cookie values survive a change of platform key. Windows DPAPI and macOS Keychain **key sources** are written but unexercised — they need the Phase 1 runners. |
| 4 — Account key | **Done, simplified** | `GET /vault/key`. No password derivation, no recovery code — see the Correction section. |
| 5 — Cloud sync | **Server + client done; not wired to the UI** | Durable filesystem blob store on the server, push/pull with compare-and-set, conflict refusal. **No UI calls it yet, and capture still seals under the per-install key** — so it is not yet a feature a user can use. |
| 6 — Leases | **Done (server)** | `GET/POST/DELETE /profiles/:id/lease`. Hard block like Octo, plus a 150s expiry so a crashed machine frees itself — which Octo requires an operator to do. Not yet called by the desktop launch path. |
| 7 — Startup performance | **Done (boot path)** | First paint no longer waits on the network. `auth_status_cached` answers from a local identity cache; `/auth/me` verifies behind the painted UI and is the only thing that may sign someone out. |
| 8 — Extensions | Blocked on a decision | Needs a fork patch exempting extensions **by ID**; the obvious path-based approach changes extension IDs and destroys their stored data. |

### Known gaps, stated rather than implied

- Sync is **not user-visible**. The commands exist; nothing calls them.
- Capture seals under the per-install key, so a push re-seals at the transport layer only.
- Windows/macOS OSCrypt key sources are unproven until the CI runners execute them.
- The `.env` leak class has now caused three separate defects (tests hitting the live database, then
  production blob storage, then sending real email from the production mailbox). Each was found while
  verifying something else. It deserves one guard that fails a run when a production-pointing
  variable is live, rather than another per-variable fix.


## Why this document exists

An eleven-agent audit of every layer (desktop Rust, engine-runner sidecar, backend, Postgres, the
React frontend, the crypto packages and the existing tests) found:

- **Cloud sync did not exist.** The desktop made exactly two network calls ever
  (`/auth/desktop/exchange`, `/auth/me`). `encrypt_profile_blob` / `decrypt_profile_blob` were
  registered Tauri commands with zero callers. The Postgres `profiles` table held 0 rows against
  44 users.
- **The server half was already built and tested** — push/pull, monotonic versions, 409
  compare-and-set, a 25 MiB cap, S3 content-addressing. Only the client half was missing.
- **Three bugs were losing data with no sync involved**: the pending cookie import was destroyed on
  first successful launch; cookie export required the profile to be *running* and launched by the
  *current* sidecar; and `--disable-extensions-except` silently prevented every user-installed
  extension from loading.

Three independent architectures were then designed and judged adversarially on three lenses
(data-loss, stealth/identity fidelity, cross-platform/ops). The judgements killed a verified fatal
flaw in each. What follows is the synthesis.

## Binding product decisions

| Decision | Choice | Consequence |
|---|---|---|
| Sync unit | Slim identity set (~1–7 MB/profile) | Whole user-data-dir measured at 0.96–4.48 GB/profile for 0.55–6.44 MB of identity. Not viable. |
| Key custody | **Server-held account key** (`GET /vault/key`, created on first use), deriving a separate key per profile | Sign in and your profiles are there. Password reset costs nothing; nothing to write down. The server can read profile data — the right posture when the operator owns the server. *(Superseded a password-derived design; see "Correction" at the end.)* |
| Cookies | Decrypted at capture into our own portable envelope | A raw file copy silently logs users out on Windows/macOS. Users must stay logged in. |
| Concurrency | Octo's model: hard block, one device at a time | Plus a 150s lease so a crashed machine self-heals, which Octo does not do. |
| localStorage | **On by default** | Octo defaults it *off* and warns users get logged out. We were asked to preserve it. |

## Ground truth that overrules intuition

These were verified on this machine against nine real profiles, and each one invalidates a design
that a reasonable engineer would otherwise have written.

1. **Lobium 152 stores localStorage and sessionStorage as WAL-mode SQLite *files*** at
   `Default/LocalStorage` and `Default/SessionStorage` — not the stock `Default/Local Storage/leveldb/`
   directory, which exists in **none** of the nine profiles. Code written against the well-known
   Chromium layout transfers zero bytes *without erroring*.
2. **IndexedDB is also WAL SQLite**, not LevelDB. A LevelDB filename allowlist
   (`CURRENT`, `MANIFEST-*`, `*.ldb`) matches none of the actual Base32-named files.
3. **Windows App-Bound encryption (`v20`) is structurally unreachable for us.** It requires a system
   install *and* the default user-data-dir; we ship a per-user NSIS installer and always pass
   `--user-data-dir`. Windows is therefore DPAPI `v10`, which our own process can read and write —
   so offline capture of a stopped Windows profile is possible.
4. **`--use-mock-keychain` would log every existing macOS user out of everything.** Chromium matches
   ciphertext by provider tag prefix; both the real and mock keys use tag `v10`, and on key failure
   the code comments "This is a permanent failure" with no alternate-key retry. The cookie row is
   then dropped.
5. **Both DOM-storage backends will coexist in the field.** The relevant features are all
   `FEATURE_DISABLED_BY_DEFAULT`; what produces the SQLite layout is a field trial whose predicate is
   `!leveldb_exists`, evaluated **per profile directory**.
6. **`Default/Bookmarks` does not exist in any profile.** ENOENT is the common path, not an edge case.
7. **There are no Windows or macOS CI runners.** Every job in `.github/workflows/ci.yml` is
   `ubuntu-latest`. Every platform-specific mitigation in all three designs was guarded by CI that
   does not exist — which is why Phase 1 is CI, before any OSCrypt work.

## Octo Browser's model, for reference

Verified against their published docs, since "follow Octo's approach" was the instruction for
concurrency.

- Cloud-stored by default; seven toggles: cookies, passwords, extensions, localStorage, history,
  bookmarks, service workers. IndexedDB is folded into the localStorage toggle.
- Their API defaults have `localstorage: false`, and their docs warn that with it off "all services
  that use Local Storage to keep data will be logged out when the profile is reopened".
- Concurrency is hard-blocked: *"It is not possible to work with the same profile simultaneously,
  but you can do so in turns."* The second opener is told *"Profile is launched on another device."*
- **No lease and no timeout.** A crashed machine leaves the profile claimed indefinitely; recovery
  is a manual "Force stop" that discards unsynced work and can split-brain.
- Sync is automatic on close, download on start. No sync button — only a retry affordance when it
  fails.
- Plans meter profile **count**, not bytes. No storage quota is documented anywhere.

We match the concurrency block and the sync triggers, and improve on the lease and the localStorage
default.

---
## Architecture


### LOBSTER PROFILE PERSISTENCE & SYNC — SYNTHESISED DESIGN ("Ledger")

Strongbox's verified transactional ledger is the spine. Molt's raw-blob DOM codec, backend probe, binary-split cookie retry, partial unique index and first-paint query are grafted on. Warm Restore's plaintext-`value` cookie fallback, read-write VACUUM handle, downgrade refusal and minimal-surface discipline are adopted. Every fatal flaw from the three judgements is resolved below, each with the source check that settles it.

---
### 0. GROUND TRUTH I VERIFIED MYSELF (these overrule all three designs and the brief)

1. **IndexedDB in Lobium 152 is SQLite in WAL mode, NOT LevelDB.** `content/browser/indexed_db/instance/sqlite/backing_store_impl.cc` exists; `prf_c30fea6b/Default/IndexedDB/https_www.payoneer.com_0/ZU2QU…` is `SQLite 3.x, 18 pages`, header bytes 18/19 = `0202` (WAL), with a live 32 KB `-shm` and a `-wal`, main file dated Jul 22 against sidecars dated today. `find -name CURRENT -o -name 'MANIFEST-*' -o -name '*.ldb'` under every `IndexedDB/` returns **nothing**. Molt's and Warm Restore's LevelDB classification would have captured zero bytes or tarred main+wal+shm non-atomically; Chromium razes a corrupt IDB backing store and recreates it empty. **Decision: per-file `VACUUM INTO`; `*.indexeddb.blob/` dirs tarred separately.**
2. **Windows App-Bound (`v20`) is structurally unreachable.** `GetAppBoundEncryptionSupportLevel()` returns `kNotSystemLevel` unless `install_static::IsSystemInstall()` and `kNotUsingDefaultUserDataDir` unless `chrome::IsUsingDefaultDataDirectory()`; `UseForEncryption()` is `support_level_ == kSupported`. Lobster is a per-user NSIS install that always passes `--user-data-dir`. **Windows is DPAPI `v10` AES-256-GCM, which our process can read AND create.** Molt's "impossible and unfixable" is false — offline Windows capture works, so gap [3] is fixable on the shipping platform.
3. **`--use-mock-keychain` destroys existing macOS profiles.** `Encryptor::DecryptData` (encryptor.cc:242-285) matches ciphertext by **provider tag prefix**, and once the tag matches but the key fails it comments *"This is a permanent failure"* and returns `nullopt` — **there is no alternate-key retry**. Both the real keychain key and the mock key use tag `"v10"`. `MakeCookiesFromSQLStatement` then records `kDecryptFailed` and `continue`s, dropping the row. **Strongbox's flag as specified logs every existing macOS user out of everything.** Decision in §4.
4. **Do NOT force `--enable-features=DomStorageSqlite`.** All three of `kDomStorageSqlite`, `kDomStorageSqliteInMemory`, `kDomStorageSqliteNewDatabases` are `FEATURE_DISABLED_BY_DEFAULT` (`dom_storage/features.cc`). What produces `Default/LocalStorage` today is the field trial at `UseSqliteForNewDatabases`, and `ShouldUseSqlite(kUseSqliteForNewDatabases, leveldb_exists)` returns **`!leveldb_exists`** — so the backend is **per-profile-directory and both backends WILL coexist in the field**. `kUseSqliteOnly` returns `true` unconditionally, so the flag makes an existing LevelDB store invisible with no Chromium migration (`TODO crbug.com/377242771`). **Decision: probe, never pin.**
5. **Warm Restore's identity artifact is destroyed on next launch.** `writeLobiumConfig` is called unconditionally at `lobium-launcher.ts:316` from `buildLobiumConfig({seed, osVersion, webrtcPolicy, proxy, rendererPolicy, hardwareNoise, mediaDevices, …})`. `lobium-fp.json` is **derived output**. **The identity unit is the profiles.sqlite ROW, not the file.**
6. **Losing the proxy is a deanonymisation.** `lobium-config.ts:186-187`: `webrtcPolicy = opts.webrtcPolicy ?? (opts.proxy ? 'disable_non_proxied_udp' : 'default_public_interface_only')`. A restore without the proxy flips WebRTC to expose host ICE candidates while the persona still claims its original timezone. **Proxy is identity payload, not just a secret.**
7. **`os` is a fingerprint input**, not metadata: `FONTCONFIG_FILE = await writeFontConfig(…, ctx.isMobileProfile ? 'android' : ctx.fingerprint.os, …)` (`lobium-launcher.ts:218-220`).
8. **MediaDeviceSalts is NOT the fingerprint.** `media_devices.cc:1489-1516` clears host enumeration and derives every deviceId arithmetically from `cfg->seeds.canvas ^ cfg->seeds.webgl ^ 0x4D454449 ('MEDI')`. Restoring the seeds reproduces every id byte-for-byte. The brief's premise, and Molt's and Warm Restore's reasoning, are wrong. Include the 24 KB DB (harmless), never depend on it.
9. **Warm Restore's plaintext-`value` fallback is real.** `MakeCookiesFromSQLStatement` errors only when `!value.empty() && !encrypted_value.empty()`; an empty `encrypted_value` skips the decrypt block entirely and loads `value` verbatim. This is the safety valve that makes "never logged out" unconditional.
10. **Windows/macOS preference enforcement, worse than Strongbox said.** `GetSettingsEnforcementGroup()` returns `GROUP_ENFORCE_DEFAULT` on `IS_WIN||IS_MAC`, `GROUP_NO_ENFORCEMENT` elsewhere. `prefs::kRestoreOnStartup` is `kTrackedPrefs` id 3 `ENFORCE_ON_LOAD/ATOMIC`. **And** `extensions::pref_names::kExtensions` (id 5) is escalated to `ENFORCE_ON_LOAD` because `GROUP_ENFORCE_DEFAULT` is the *highest* enum value and `chrome_pref_service_factory.cc:260-264` escalates at `>= GROUP_ENFORCE_ALWAYS_WITH_EXTENSIONS_AND_DSE`. So **both** launcher pref writes are live Windows/macOS bugs.
11. **macOS saved passwords DO work.** `keychain_identifier` is written only inside `#if BUILDFLAG(IS_IOS)` (`login_database.cc:886-894`); on macOS desktop `password_value` holds OSCrypt ciphertext normally. Warm Restore's risk #3 is retired. Login Data `kCurrentVersionNumber = 43`, `kCompatibleVersionNumber = 40`.
12. **`Storage` domain has no `enable` command** (only `getCookies:274`, `setCookies:283`, `clearCookies:291`), so the stealth invariant holds trivially. Cookies v24: `kCurrentVersionNumber = kCompatibleVersionNumber = 24`.
13. **The WAL trap is live on disk.** `prf_6d04dd17/Default/LocalStorage` = **4096 B main against 28872 B of `-wal`**. Copying the main file alone transfers essentially nothing, silently. All 9 profiles are SQLite-file today, 0 have LevelDB — but see (4).
14. **Ops:** no `client_max_body_size` in `deploy/nginx/*.conf`; 0 `S3_` vars in backend env; CI is `ubuntu-latest` only (plus self-hosted agent-battery/gpu) with **no Windows or macOS runner** and `product-e2e` in **no** workflow; `assertCanAddProfiles` counts `findAllByTeam(teamId).length` with `DEFAULT_FREE_PROFILE_LIMIT`.
15. **Already-present Rust deps:** `rusqlite 0.32 (bundled)`, `argon2 0.5`, `aes-gcm 0.10`, `hkdf 0.12`, `sha2 0.10`, `keyring 3`, `tar 0.4`, `flate2 1`, `reqwest 0.12`, `chrono`, `uuid`. **New:** `blake3 = "1"`, `zstd = "0.13"`, `snap = "1.1"`, `zeroize = "1"`, `ciborium = "0.2"`, `base32 = "0.5"`, `rand = "0.8"`; `[target.'cfg(windows)'] windows = { version = "0.58", features = ["Win32_Security_Cryptography"] }`; `[target.'cfg(target_os="macos")'] security-framework = "3"`.

---
### 1. THE SYNC UNIT — allowlist manifest, identity is the ROW

Never the user-data-dir (0.96–4.48 GB for 0.55–6.44 MB of identity), never a denylist (gap [14] — a ~40-name list silently re-inflates). An enumerated registry of typed artifacts, each with extractor, codec, BLAKE3 digest, writer and verifier. A Chromium version that adds `OptGuideOnDeviceModel/weights.bin` cannot enter the set because nothing enumerates it.

`snapshot/manifest.rs` → `const ARTIFACTS: &[ArtifactSpec]`:

| id | source | kind | required |
|---|---|---|---|
| `identity` | **profiles.sqlite row** + `proxies` row + extension refs + font-pack id; `lobium-fp.json` captured as `identity.resolved` for **verification only** | canonical CBOR | **YES — restore ABORTS if absent or codec unknown** |
| `cookies` | `Default/Cookies` (SQLite, journal_mode=delete, v24) | 20-column records, OSCrypt-transcoded | yes |
| `localstorage` | probed: `Default/LocalStorage` (SQLite WAL) **or** `Default/Local Storage/leveldb/` | raw-blob rows **or** dir tar | yes |
| `sessionstorage` | probed likewise | same | default on |
| `indexeddb` | `Default/IndexedDB/<origin>/<Base32>` **SQLite per file** + `*.indexeddb.blob/` | per-file `VACUUM INTO` + tar | default on |
| `passwords` | `Default/Login Data`, `Login Data For Account` (v43/compat 40) | transcoded records | default on |
| `autofill` | `Default/Web Data`, `Account Web Data` | transcoded records (`credit_cards` separate opt-in) | default on |
| `extension-state` | `Default/{Local,Sync} Extension Settings/<id>`, `Extension State`, `Extension Rules`, `Extension Scripts` (LevelDB dirs) | tar.gz, **keyed by manifest extension ref, remapped on apply** | quiesced-only, `fidelity:"stale"` until Phase 8 |
| `serviceworkers` | `Default/Service Worker/{Database,ScriptCache}` | tar.gz | quiesced-only, **default OFF** until proven |
| `history` | `Default/History` (WAL) | `VACUUM INTO`; missing `urls` table ⇒ empty, never throw | default on |
| `bookmarks` | `Default/Bookmarks` | raw JSON; **ENOENT is the common path (0/9)** | default on |
| `prefs-subset` | untracked allowlist only | canonical CBOR | default on |
| `tabs` | semantic `[{url,title,index,active}]` | canonical CBOR | default on |

`identity` carries: `fingerprint_seed`, `fingerprint_overrides`, `engine`, `engine_build`, `os`, `os_version`, `webrtc_policy`, `proxy {type,host,port,username,password}` + `proxy_id`, `extension_refs [{id, version, source, sha256, manifest_key}]`, `font_pack_id` + `FONT_CONFIG_SCHEMA_VERSION`, `template_id`, `name/tags/folder/notes`, `sync_options`. On restore, after writing the row and relaunching, the engine regenerates `lobium-fp.json`; we **diff it against `identity.resolved`** and hard-fail the restore on any seed/persona/webrtc/proxy divergence. That is the mechanism that makes "same browser" provable rather than asserted.

**Excluded by not being listed:** `Cache`, `Code Cache`, `GPUCache`, `DawnGraphiteCache`, `DawnWebGPUCache`, `blob_storage`, `Shared Dictionary`, `component_crx_cache`, `OptGuideOnDeviceModel` (2.7 GB), `SODA*`, `TranslateKit`, `screen_ai`, `WasmTtsEngine`, `System Profile/` (a second profile-shaped tree in `prf_1807ead7`), `Webstore Downloads`, `TransportSecurity`, `Network Persistent State`, `DIPS`, `Trust Tokens`, `BrowsingTopicsState`, `SharedStorage`, `host-calibration.json`, `deviceidhashsalts/`, `lobium-fonts.conf`/`font-files/`/`fc-cache/` (119 MB of hardlinks with absolute host paths — **regenerated** by `fonts.ts` on restore), `Preferences`/`Secure Preferences` as files, `Sessions`/`Sessions_Encrypted`, and every runtime artifact (`SingletonLock`, `SingletonSocket`, `SingletonCookie`, `DevToolsActivePort`, `LOCK`, `LOG*`, `*-journal`, `*-shm`, `*-wal`).

---
### 2. NEW CODE, NAMED

**Rust — `apps/desktop/src-tauri/src/`**
- `snapshot/mod.rs` — `capture(profile_id, CaptureMode) -> SnapshotManifest`, `restore(profile_id, version, RestorePlan) -> RestoreReport`, `verify(profile_id, version) -> VerifyReport`
- `snapshot/manifest.rs` — `ARTIFACTS`, canonical CBOR (`ciborium`), BLAKE3 digests
- `snapshot/sqlite_copy.rs` — `vacuum_into()`, `backup_fallback()`, `assert_no_live_owner()`
- `snapshot/dom_storage.rs` — probe + raw-blob codec + LevelDB tar path
- `snapshot/cookies.rs`, `snapshot/passwords.rs`, `snapshot/autofill.rs`
- `snapshot/idb.rs` (per-file SQLite + blob dirs), `snapshot/leveldb_tar.rs`, `snapshot/prefs.rs`, `snapshot/tabs.rs`, `snapshot/archive.rs`
- `oscrypt/{mod,linux,macos,windows}.rs` — the platform key ring
- `keys/{mod,enroll,unlock,recovery}.rs` — Argon2id/UMK/UKWK/ADK/recovery
- `sync/{mod,client,worker,lease,cas}.rs` — reqwest client, durable queue, heartbeat, local CAS
- `blob_crypto.rs` — extended to `LBv2` with AAD; `#![allow(dead_code)]` deleted

**Sidecar — `packages/engine-runner/src/`**
- `snapshot/quiesce.ts` — `gracefulStop`, WAL-drain wait, lock cleanup
- `snapshot/storage-cookies.ts` — `Storage.getCookies/setCookies/clearCookies` on the **browser** endpoint (replaces deprecated `Network.getAllCookies/setCookies` in `cookie-inject.ts:108-162`), full fidelity incl. `partitionKey`, `sourceScheme`, `sourcePort`, `priority`, **with binary-split retry**
- `snapshot/vault.ts` — network-incapable capture launch (§5)
- `rpc.ts` — `+ quiesce`, `+ vaultExportCookies`, `+ vaultImportCookies`
- `runners/lobium-launcher.ts` — pref-write fixes, lock cleanup (§7)

**Backend — `apps/backend/src/`**
- `profiles/snapshots.controller.ts`, `snapshots.service.ts`, `chunks.controller.ts`
- `profiles/leases.controller.ts`, `leases.service.ts`
- `keys/keys.module.ts` + controller/service
- `common/roles.guard.ts`, `common/api-exception.filter.ts` (there is none today — every error uses Nest's default shape while every success uses `{code,data,msg}`)
- `profiles/chunk-gc.service.ts` + `chunk-scrub.service.ts`

---
### 3. DOM STORAGE — probe, then raw bytes (Molt's codec, Strongbox's safety)

**Probe at capture AND restore** (`snapshot/dom_storage.rs::detect_backend`): `Default/LocalStorage` regular file ⇒ `sqlite`; `Default/Local Storage/leveldb/` directory ⇒ `leveldb`; both ⇒ `ambiguous` and **refuse**; neither ⇒ `empty`. Record in `profiles.dom_storage_backend`. **Restore refuses to cross backends** with an explicit message rather than transferring nothing (gap [5]'s silent-zero failure). A CI assertion requires exactly one to exist after a real launch, so a field-trial flip fails a test instead of shipping.

**WAL-safe copy.** Open **read-write** (Warm Restore is right: a read-only handle cannot recover a WAL whose `-shm` is missing after an unclean exit — and that is precisely the crashed-profile case the engine exists to serve):
```rust
let c = Connection::open(src)?;                       // READ-WRITE, deliberately
c.busy_timeout(Duration::from_millis(2500))?;
c.execute("VACUUM INTO ?1", params![dst.to_string_lossy()])?;
```
`VACUUM INTO` (SQLite 3.27+; rusqlite 0.32 bundled ships 3.46) takes a read transaction, walks committed state with the WAL fully accounted for, and emits one clean file with no sidecars. On persistent `SQLITE_BUSY`: `rusqlite::backup::Backup::new_to` stepping 512 pages ×20 with 250 ms sleeps. **Never** `PRAGMA wal_checkpoint(TRUNCATE)` (mutates a live DB, silently degrades to PASSIVE under any reader, tears the following copy). **Never** copy the main file alone — `prf_6d04dd17` proves the loss.

**Codec — raw blobs, no decode (Molt).** Read the VACUUM'd copy:
```sql
SELECT value FROM meta WHERE key='version';   -- must be '1', else refuse
SELECT m.row_id, m.storage_key, m.last_accessed, m.last_modified,
       e.key, e.value_compression_type, e.value
  FROM maps m JOIN map_entries e ON e.map_id=m.row_id ORDER BY m.row_id, e.key;
```
Emit `{sk: <storage_key raw bytes b64>, la, lm, e:[{kB64, vB64, c}]}` where `kB64`/`vB64` are the **exact BLOBs** — leading `StorageFormat` byte intact — and `c` is `value_compression_type` **verbatim**. We never decode UTF-16/Latin-1 and never decompress. This buys byte-exact round-trip, immunity to a future third `StorageFormat` or fourth `CompressionType`, zero zstd/snappy dependency on the sync path, and free cross-platform correctness. `storage_key` is a serialized `blink::StorageKey` and may be partitioned (`https://a2857433013137.cdn.optimizely.com/^0https://payoneer.com` observed) — treated as opaque bytes, never parsed.

`zstd`/`snap` are still linked, **decode-only**, used solely by the UI's "N origins / M keys" display and the JSON import/export path (gap [4], the competitive wedge — no vendor documents a localStorage import).

**Restore.** Build a fresh DB at `<udd>/Default/.lobster-stage/LocalStorage` with the verified DDL (`maps(row_id INTEGER PRIMARY KEY AUTOINCREMENT, storage_key BLOB NOT NULL, last_accessed INTEGER, last_modified INTEGER, total_size INTEGER)` + `CREATE UNIQUE INDEX maps_by_storage_key`; `map_entries(map_id INTEGER NOT NULL, value_compression_type INTEGER NOT NULL, key BLOB NOT NULL, value BLOB NOT NULL, PRIMARY KEY(map_id,key)) WITHOUT ROWID`; `meta` rows `version='1'`, `last_compatible_version='1'`, `mmap_status='-1'`), inserting blobs and compression types verbatim. `total_size` NULL (nullable, quota-only, recomputed by `StorageAreaImpl`). Then `PRAGMA integrity_check`, read back through the capture codec, assert byte-identical to the manifest, `fsync`, move existing `LocalStorage`/`-wal`/`-shm` into `<udd>/Default/.lobster-pre-restore-<ts>/`, atomically rename in. **Rollback from the pre-restore copy on any mismatch.**

`SessionStorage` shares `map_entries` but adds `session_metadata(session_id TEXT NOT NULL, storage_key BLOB NOT NULL, map_id INTEGER NOT NULL, PRIMARY KEY(session_id, storage_key)) WITHOUT ROWID`. Because `session_id` is the SNSS namespace id, sessionStorage is **captured always, restored only same-machine**; cross-machine records `sessionstorage:{restored:false, reason:"namespace-ids-not-transferable"}`.

---
### 4. COOKIES ON WINDOWS, macOS AND LINUX

One trait, three providers. Formats from `encryptor.cc:101-192`: `Aes128Cbc` = `tag ‖ AES-128-CBC(key, IV=16×0x20, PKCS#7)`; `Aes256Gcm` = `tag ‖ nonce(12) ‖ ct ‖ tag(16)`. Legacy AES-128-CBC retries the empty-password key `d0d0ec9c7d77d43ac54187fa4818d17f`.

```rust
pub enum OsKey { Aes128Cbc([u8;16]), Aes256Gcm([u8;32]) }
pub trait OsCryptKeyring {
    fn keys_for_decrypt(&self) -> Vec<(&'static str, OsKey)>;   // try-order
    fn key_for_encrypt(&mut self) -> Result<(&'static str, OsKey)>;
}
```
- **Linux** — `v10` = `PBKDF2-HMAC-SHA1("peanuts","saltysalt",1,16)` = `fd621fe5a2b402539dfa147ca9272778`, because `lobium-launcher.ts:370` pins `--password-store=basic` so `PosixKeyProvider` is the only provider. Legacy `v11` keyring key kept decrypt-only.
- **Windows** — no flag needed. Read `Local State → os_crypt.encrypted_key`, base64-decode, strip the 5-byte `"DPAPI"` prefix, `CryptUnprotectData` → 32-byte AES-256-GCM key. If absent (fresh dir on target): 32 CSPRNG bytes → `CryptProtectData` → write `base64("DPAPI" ‖ blob)` back atomically. A CI guard asserts `os_crypt.app_bound_encrypted_key` is **absent** after a real launch and that the launcher always emits `--user-data-dir`, so a future Chromium change that reaches `v20` **fails the build** instead of silently logging out every Windows user.
- **macOS — RESOLVING STRONGBOX'S FATAL FLAW.** `--use-mock-keychain` is real (`os_crypt_switches.h`, no test buildflag; consumed in `KeychainKeyProvider::GetKeyTask`; `FakeKeychainV2` password is the constant `"mock_password"` ⇒ `v10 = PBKDF2-HMAC-SHA1("mock_password","saltysalt",1003,16)`), and it is genuinely the most elegant macOS answer. But because `DecryptData` fails **permanently** on a tag-match with the wrong key, it may only be applied where no ciphertext under the real key exists. Therefore:
  - `profiles.oscrypt_mode ∈ {'keychain','mock','pending-migration'}`, default `'keychain'`.
  - **New macOS profiles** (never launched) enrol as `'mock'` and get the flag from birth.
  - **Existing macOS profiles** stay `'keychain'`. Migration is explicit, per profile, and **rewrites the jar before the flag is ever passed**: quiesce → read `Cookies`/`Login Data`/`Web Data` with the real keychain key (one-time consent dialog, never silent) → re-encrypt every row under the mock key → read-back verify → set `'mock'`. Any failure leaves the profile `'keychain'` with the pre-restore copy intact. A profile in `'pending-migration'` **never** receives the flag.
  - If keychain consent is denied: stay `'keychain'`, and use the vault launch (§5) for capture. Restore still succeeds via the plaintext-`value` fallback below.
- **The key oracle makes this self-verifying.** At v24 the plaintext is `SHA256(host_key) ‖ value` (`sqlite_persistent_cookie_store.cc:1293`, checked at :986-999). We try each candidate key and accept only the one whose output starts with the correct domain hash. Wrong key, tampered row and transplanted row all reject by construction.

**Capture.** All 20 v24 columns (`creation_utc, host_key, top_frame_site_key, name, value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port, last_update_utc, source_type, has_cross_site_ancestor`). Four — `creation_utc`, `last_access_utc`, `last_update_utc`, `source_type` — have **no CDP representation**, which is why the offline reader is primary. Refuse `meta.version > 24`. A live partitioned row exists in real data (`api.hcaptcha.com/hmt_id` with `top_frame_site_key=https://1procard.com`, `has_cross_site_ancestor=1`), so a CDP-only capture would silently destroy embedded-login, SSO and payment sessions.

**Restore — three tiers, never a logout.**
1. **Offline writer (preferred).** Create v24 table + `cookies_unique_index`, `PRAGMA journal_mode=DELETE`, insert `encrypted_value = oscrypt_encrypt(SHA256(host_key) ‖ value)` under the target key, `value=''`. Read back through the decrypt path, assert the record digest set equals the manifest, then swap.
2. **Plaintext-`value` fallback** when the target key is unreachable (denied macOS keychain). Write `value` populated, `encrypted_value` empty — verified loadable, since `MakeCookiesFromSQLStatement` errors only when both are non-empty. Recorded as `cookies:{atRest:"plaintext"}` in the manifest and **surfaced in the UI**. On Linux this is not even a degradation (`v10` is a hardcoded key already).
3. **CDP path** when `manifest.engineBuild` differs in major version from the target (writing a v24 DB under an engine expecting v25 triggers Chromium's own migration on a foreign-written DB, untested behaviour). Uses `Storage.setCookies` **with binary-split retry**: try the full batch; on rejection split and retry to isolate offenders; inject every good cookie; return `{injected, rejected:[{name,domain,reason}]}`. A launch is **never** blocked by one bad cookie (gap [35]). Records `cookies:{fidelity:"cdp"}` so the four missing metadata columns are visible as data.

**Downgrade is refused** (Warm Restore): restoring into an older engine makes Chromium raze a "too new" DB = total cookie loss. Explicit override only.

`passwords`/`autofill` ride the same module (`logins.password_value`, `credit_cards.card_number_encrypted`); refuse to write a DB whose `last_compatible_version` exceeds what we know (Login Data 43/40).

---
### 5. CAPTURE MODES, AND THE UNLAUNCHABLE PROFILE

**Invariant, with a test:** capture is a filesystem read. It **never** calls `profile_store::verify_password` and **never** requires `status==='running'`. Today `local_api.rs:190-196` gates on the profile password and `composite.ts:121-122` throws `is not running` — the two conditions that make an unlaunchable profile unrecoverable (gap [3]).

- **Mode A — Quiesced (authoritative).** `assert_no_live_owner()` reads `SingletonLock` (a `hostname-pid` symlink) and `DevToolsActivePort` and checks pid liveness. Sidecar `quiesce`: `Browser.close`, wait ≤5 s for exit (clean shutdown checkpoints and removes `-wal`), else SIGTERM (helper exists at `lobium-launcher.ts:422`) then SIGKILL. Then delete `SingletonLock`, `SingletonSocket`, `SingletonCookie`, `DevToolsActivePort`, `Default/LOCK` and every LevelDB `LOCK`. Chromium has **no cross-store transaction**, so this is the only mutually-consistent mode.
- **Mode B — Live autosave, every 90 s.** SQLite artifacts via `VACUUM INTO` (safe: read lock only, never mutates). LevelDB-backed `extension-state`/`serviceworkers` are **skipped** and carried forward by digest with `staleFrom:<version>`. Bounds crash loss to ≤90 s; no competitor ships this.
- **Mode C — Dirty / unlaunchable.** File phase only, against a possibly-dirty dir. Per-DB consistency holds via `VACUUM INTO`; cross-store does not ⇒ `coherence:"dirty"`. Cookies come from the offline reader with a visible `{decrypted, total}` tally. **This is the mode that makes Windows recoverable** — and it works, per §0(2).
- **Vault launch — universal fallback** (`snapshot/vault.ts`): `--user-data-dir=<udd> --remote-debugging-port=0 --headless=new --no-startup-window --no-first-run --disable-extensions --password-store=basic --host-resolver-rules=MAP * ~NOTFOUND --proxy-server=socks5://127.0.0.1:1` **plus `--lobium-fp-config=<path>` and `FONTCONFIG_FILE`** — closing the stealth hole Judge 2 found in Strongbox, where a host-fingerprinted process would write GPU/font/pref state into an anti-detect profile. Network-incapable by construction, never navigates, talks only to the browser endpoint via `Storage.*` (no `enable` exists). Used for: denied-keychain macOS capture; a belt-and-braces cross-check of the offline reader (both must agree on the cookie digest set or the snapshot is flagged); and restore-through-Chromium.

`cookies` + `localstorage` + `indexeddb` are captured back-to-back and the manifest records `coherence:{windowMs}`; above 2000 ms it is labelled `loose`. **The restore UI defaults to the newest QUIESCED snapshot over a newer loose one** unless the user explicitly overrides — a cookie/localStorage token pair captured 30 s apart is a half-session a site can read as a hijack signal.

---
### 6. RESTORE SAFETY — the thing only Strongbox had

Every artifact: **stage → `fsync` → `integrity_check` → read back through the capture codec → compare to manifest digest → move current files (with `-wal`/`-shm`/`-journal`) into `<udd>/Default/.lobster-pre-restore-<ts>/` → atomic rename → on any mismatch, restore the pre-restore copy and report.** Nothing is `rm -rf`'d before its replacement is verified — resolving the shared Molt/Warm-Restore fatal flaw. After the whole set lands: write `identity` to the profile row, relaunch, regenerate `lobium-fp.json`, and **diff it against `identity.resolved`**; a seed/persona/webrtc/proxy/font-pack divergence is a hard, reported failure. `RestoreReport` returns per-artifact counts (cookies restored/dropped, localStorage origins/keys, IDB dbs, extension dirs remapped/orphaned, passwords re-encrypted/skipped) plus `atRest` state.

---
### 7. LAUNCHER FIXES (all three designs' pref findings, merged)

1. **Delete the `session.restore_on_startup` pref write** (`lobium-launcher.ts:495,:640`). `--restore-last-session` at :373 already does the job, and the write trips a real preference reset on Windows/macOS per §0(10).
2. **`extensions.settings` writes must not corrupt tracked prefs.** Because id 5 escalates to `ENFORCE_ON_LOAD/SPLIT` on Win/Mac, `ensureLobeePreferences` needs a Windows/macOS-specific answer. Interim: keep the write but add a Windows/macOS assertion test that Lobee still loads and no `preference_reset_time` appears after two launches; if it fails, move Lobee loading fully onto `--load-extension`/`--disable-extensions-except` and stop touching the pref. **This is a Phase-8 blocker, not a Phase-2 one, but it must be measured in Phase 1.**
3. **One atomic Preferences write per launch.** Replace the four `writeFileSync` calls (`:498,:533,:563,:642`) with one `writeAtomic()` (temp at `mode 0o600` → `fsync` → `rename`), mirroring Chromium's own `ImportantFileWriter` (gap [29]).
4. `snapshot/prefs.rs` carries `const KTRACKED_PREFS: &[&str]` mirrored from `chrome_pref_service_factory.cc:118-193`, refuses to write any key in it or under `extensions.settings`, and a test **fails the build** if the fork's list changes.
5. Remove `SingletonLock`/`SingletonSocket`/`SingletonCookie` beside the existing `clearDevToolsActivePort` at `:775`.
6. Register a Tauri `RunEvent::ExitRequested` handler that quiesces running browsers (gap [38] — today `lib.rs:1507` registers none, so quit orphans a live Chromium owning the UDD).
7. `prefs-subset` allowlist, **untracked keys only**: `profile.content_settings.exceptions`, `profile.default_content_setting_values`, `partition.default_zoom_level`, `profile.per_host_zoom_levels`, `intl.*`, `translate_*`. Never `default_search_provider_data` (Warm Restore's insight: excluding it deletes the protected-pref-MAC question), never `homepage`, `pinned_tabs`, `session.*`, `extensions.settings`, never `Secure Preferences`. Restore **merges** into the target's own Preferences and lets Chromium recompute its MACs.

---
### 8. KEY HIERARCHY (as built — simplified)

> The elaborate password-derived ladder that was here (UMK → UKWK → ADK, recovery codes, double
> wraps) has been **removed**. It is preserved only in the "Correction" section at the end of this
> document, which explains why. What follows is what the code does.

```text
  sign in ──▶ GET /vault/key ──▶ account key ──HKDF(key, profileId)──▶ per-profile key ──▶ LBv1 seal
```

- **Account key**: 32 random bytes per user, generated by the server on first request and returned to
  any client that can sign in. Never derived from anything the user types.
- **Per-profile key**: `PCK = HKDF-SHA256(accountKey, info="lobster/pck/v1:" ‖ profileId, 32)` and
  `key_id = HKDF-SHA256(accountKey, info="lobster/pck-key-id/v1:" ‖ profileId, 16)`. Per profile so
  one profile's key does not open another's.
- **Cross-language**: Rust and TypeScript must derive identical bytes or a snapshot sealed on one
  platform will not open on the other. Both assert against
  `packages/crypto/fixtures/key-derivation-vectors.json`; the test was verified to *catch* a
  divergence, not merely to pass.
- **Held in memory only** on the desktop. Persisting it would put a copy on that machine's disk for
  no benefit, since it is re-fetchable by anyone who can sign in.

### 9. SYNC PROTOCOL — manifest + content-addressed chunks

**Reused as-is:** team-scoped auth resolution, the audit pipeline, the `{code,data,msg}` envelope, and `S3BlobStore`'s `If-None-Match: '*'` conditional-create as the atomic CAS primitive. That mechanism is correct and load-bearing; it is simply pointed at a content-addressed layout.

Each artifact is `LBv2`-encrypted then split into ≤8 MiB chunks (`chunkIndex`/`chunkCount` inside the AAD, so a reordered or truncated stream fails authentication). Chunk id = BLAKE3-256 of the **ciphertext** — so the server verifies integrity **without decrypting**. S3: `<prefix>cas/<teamId>/<d0d1>/<digest>`, `<prefix>manifests/<teamId>/<profileId>/<version>.enc`, `ServerSideEncryption: 'AES256'`, and the `Metadata {team-id, profile-id}` topology leak dropped.

```
POST   /profiles/:id/snapshots            { baseVersion, manifest, chunks[{digest,size}],
                                            coherence, captureMode, capturedAt, engineBuild,
                                            deviceId, leaseId }
    → 201 { version, uploadNeeded[], manifestUploadNeeded }
      409 { code:'profiles.stale_base_version', data:{ currentVersion } }
      409 { code:'profiles.lease_revoked' }
PUT    /profiles/:id/snapshots/:version/chunks/:digest   (octet-stream ≤8 MiB, idempotent)
    → 400 'profiles.digest_mismatch' | 400 'profiles.not_encrypted'
POST   /profiles/:id/snapshots/:version/commit
    → 200 { version, bytes, chunkCount } | 409 'profiles.snapshot_incomplete' { missing[] }
GET    /profiles/:id/snapshots?limit=20
GET    /profiles/:id/snapshots/:version/manifest
GET    /profiles/:id/snapshots/:version/chunks/:digest   (ETag, Range)
POST   /profiles/chunks/probe             { digests[≤1000] } → { missing[] }
GET    /profiles/sync-state               -- ONE call for the whole team
GET    /profiles/events                   -- SSE: version + lease deltas
POST   /profiles/:id/lease                { deviceId, deviceLabel, ttlSeconds:150 }
    → 201 { leaseId, expiresAt, version }
      409 { code:'profiles.in_use', data:{ holder:{memberEmail, deviceLabel, since}, expiresAt } }
POST   /profiles/:id/lease/renew          { leaseId }  → 200 { expiresAt } | 409 revoked
DELETE /profiles/:id/lease                { leaseId }  → 204
POST   /profiles/:id/lease/force-release              (admin only, audited)
GET/PUT /keys/enrollment                              (idempotent-once)
POST   /keys/rotate-password · POST /keys/recover
```
`POST /profiles/:id/sync` is kept as a deprecated shim mapping one push/pull onto a one-artifact snapshot.

**Versioning.** `baseVersion` becomes **required** (`sync-profile.dto.ts:26-29` drops `@IsOptional()`; `profiles.service.ts:371`'s "omitting writes unconditionally" is the silent-clobber door). CAS in one transaction:
```sql
UPDATE profiles SET "snapshotVersion" = $2 + 1, "updatedAt" = now()
 WHERE id = $1 AND "snapshotVersion" = $2 AND "deletedAt" IS NULL
 RETURNING "snapshotVersion";
```
Zero rows ⇒ `409 profiles.stale_base_version` **with the current version in the body**, so a client branches without a second round trip and without string-matching. Machine-readable codes throughout, mirroring Octo (`profiles.in_use` ≈ `profiles.started`, `profiles.stale_base_version` ≈ `profiles.consistency_error`). A global `ApiExceptionFilter` puts errors in the same envelope as successes.

**Server-enforced zero-knowledge** (gap [20]): push rejects any manifest not starting `LBv2` with `alg==0x01` and a non-zero `key_id`.

**Ordering.** Chunks → manifest → commit. `snapshot_versions.state` goes `pending → committed` in one transaction after every chunk is confirmed present; readers only ever see `committed`; a reaper deletes stale `pending` rows after 24 h. So a partial upload is never readable and a manifest is never dangling.

**Local ledger is the durable copy; the cloud is a replica.** A capture is committed to `<appData>/snapshots/` and checksummed **before a byte hits the network**, so a permanently offline machine still has a verified ledger. Local CAS at `<appData>/snapshots/cas/<d0d1>/<digest>` with **`ref_count` pinning** — resolving Molt's fatal flaw, where a 2 GiB LRU with no ref-count lets the durable queue drain against evicted chunks. **Nothing local is pruned until its `committed` ack lands.**

**Retries.** Durable `sync_queue` in `profiles.sqlite`; backoff `1s→2→4→…→300s` ±20 % jitter, `Retry-After` honoured, resumable per chunk via `ETag`/`Range`; ≤2 concurrent PUTs, ≤6 GETs, 8 MiB/s token bucket, never holding the `profiles.sqlite` mutex across an `await`. After 12 attempts ⇒ `needs_attention` **with the reason surfaced** (Octo shows only an unexplained red triangle).

**Retention & GC — resolving both GC flaws.** Keep the last 10 committed snapshots plus the newest per calendar day for 30 days. **Never prune in the same request that writes** (Warm Restore prunes inside `push()` using the `deleteAll` path that has zero test coverage and an unreachable branch in the existing S3 fake — a bug there deletes live versions during the very operation meant to protect them). Pruning is a separate job. Chunks are reclaimed only when `refCount` hits zero across all retained snapshots, after a **90-day grace**, and additionally:
- **`chunk-scrub.service.ts`** — a nightly job that re-verifies every retained manifest's chunks are present in S3 and alarms on any gap. Neither Strongbox nor Molt re-verified after commit, so a reachability bug would silently gut retained snapshots and surface only when a user tried to restore.
- **Pre-serve completeness check** on `GET …/manifest`.
- **S3 versioning + 7-day soft-delete** on the bucket as the last net.

**Tombstones.** `DELETE /profiles/:id` sets `deletedAt` (today `prisma.profile.delete` is a hard delete, so an offline machine resurrects the profile — the classic unfixable bug, gap [13]). **`deletedAt: null` must be added to every `findMany`/`findById` filter**, because `assertCanAddProfiles` counts `findAllByTeam(teamId).length` and tombstones would otherwise eat the free-tier allowance forever. Locally, the trash path (`lib.rs:479`) must call `remove_profile_data_dir`, which today runs only on permanent delete (`:539`).

**Quota — enforced on live bytes only, scaled by the plan (revised 2026-09-02).** The earlier position here — "any byte cap warns; a hard cap that refuses a push is a mechanism for losing sessions" — was written against a flat cap counting every stored version. The audit found the constant enforced nowhere and every version kept forever, and the owner's decision was to enforce it. What shipped keeps the original concern intact: the quota counts the **latest snapshot of each profile** (what a user can act on), never retained history (which they cannot); it is the free-tier figure (`BLOB_TEAM_QUOTA_BYTES`, 250 MiB) scaled by the account's entitled profile count, so a compliant client on any tier — every profile at the 25 MiB per-blob cap — never meets it; and a refused push answers **507** with a message the launcher prints verbatim. Retention is separate: `BLOB_RETAIN_VERSIONS` (5) per profile, the newest never pruned. Profile **count** remains the metered plan dimension, and it is now counted per billing account across every team the owner has.

**The step all three designs skipped: creating the server row.** All three jump to `POST /profiles/:id/snapshots` against a row that does not exist (Postgres `profiles` holds **0 rows** against 44 users, while this box alone has 9 local profiles). Sync therefore begins with an explicit reconcile: `POST /profiles/bulk-adopt` sends local profiles' `{localId, name, engine, os, osVersion, fingerprintSeedDigest, metadata}` and returns server ids. On `403` from `assertCanAddProfiles` the UI states plainly which profiles are **not backed up** and why, offers the upgrade path, and lets the user choose which N to sync — instead of a bare `ForbiddenException` and a lie in `AuthScreen.tsx:70`. The lapsed-subscription case (20 profiles, limit drops to 3) keeps all existing profiles syncing and blocks only new ones.

**Deployment preconditions (without these it is dead on arrival):** `client_max_body_size 16m;` in `deploy/nginx/lobster-backend.conf` (nginx's 1 MB default 413s any realistic push with bare HTML before Node sees it); `app.set('trust proxy', 1)` in `main.ts` (behind nginx on 127.0.0.1 every user shares one 120 req/min bucket keyed on the proxy's loopback IP, so a bulk restore 429s everyone including auth); set `S3_*` **and** refuse to boot when `NODE_ENV=production && !S3_BUCKET`; `blobRef` from the real bucket + `S3_KEY_PREFIX` instead of the hardcoded `s3://lobster-profiles/`; MinIO in CI for `S3BlobStore` (the whole conflict story rests on `If-None-Match: '*'` returning 412 and read-your-writes `ListObjectsV2`; R2/MinIO/older S3-compatibles differ, and `deleteAll` has zero coverage); `RolesGuard` on destructive routes (today any just-invited member can delete a profile and purge every version).

---
### 10. CONCURRENCY — single writer as a platform invariant

**Deny the second opener. No toggle, no plan gate, no queueing, no merge.** Octo hard-blocks with no opt-out and is right; GoLogin ships Session Lock **off** with documented silent last-writer-wins, Multilogin gates it behind Team/Scale/Custom, AdsPower lets you disable it — all three leave the corruption path reachable for most users. For an anti-detect product, one identity from two IPs simultaneously is itself a detection event. CRDT-merging cookie jars, WAL SQLite DOM stores and IndexedDB is not tractable.

**A DB invariant, not application logic** — resolving Warm Restore's fatal flaw (five nullable columns with lazy expiry and no CAS statement):
```sql
CREATE UNIQUE INDEX profile_leases_one_active
  ON profile_leases(profile_id) WHERE released_at IS NULL AND revoked_at IS NULL;
```
Acquire is a single statement (`INSERT … ON CONFLICT (profile_id) DO UPDATE SET … WHERE profile_leases."expiresAt" < now() OR profile_leases."revokedAt" IS NOT NULL RETURNING *`) inside the transaction that reads `snapshotVersion`; zero rows ⇒ `409 profiles.in_use`. Molt's partial unique index sits **under** the CAS so double-holding is physically impossible at the storage engine, not merely correct in the statement we wrote.

**Enforced at both layers**, as Octo does (cloud 409 + local `ProfileAlreadyRunningException`): `local_api.rs::start_profile_via_sidecar` refuses to launch without a valid local lease row, and `CompositeRunner.launch`'s in-process guard (`composite.ts:41-43`) becomes a typed `{code:'profiles.started'}`.

**Heartbeat lease — differentiator 1.** TTL 150 s, renewed every 30 s by `sync/lease.rs`. Server auto-expires a lease whose heartbeat stopped. **Renew failure stops the browser** (Molt): a 30 s grace window with immediate retry on failure and on resume covers laptop sleep and long GC pauses; if the lease still cannot be held the runner quiesces and captures rather than keep running unclaimed. Octo pins a crashed profile as launched *indefinitely*; Multilogin makes users hand-delete `.lock` files from `~/mlx`. A dead Lobster machine frees its profile in ≤150 s with no human action.

**Authoritative revocation — differentiator 2.** Octo's Force stop explicitly does not close the other window and silently discards that member's later work. Because we own the runner: the revoked runner learns on its next heartbeat (≤30 s), quiesces, **captures locally**, and tells the user who took over. Any push or commit presenting a revoked `leaseId` is `409 profiles.lease_revoked`. **The revoked side's snapshot is retained and offered as a conflict — never discarded**, and additionally written as a single named file `<appData>/orphaned-snapshots/<profileId>-<ts>.lbsnap` (Warm Restore) so support has one artifact to hand back.

**Live holder identity — differentiator 3.** All four vendors show an anonymous padlock or nothing. Our badge: **"In use — alice@example.com on 'MacBook-Pro', since 14:02 (expires 14:07)"**, from a `devices` table, served by `GET /profiles/sync-state` and kept live over SSE. Vocabulary follows Octo: **In use** / **Force release**; "locked" stays internal error-code language.

**Conflicts are presented, never resolved.** "Cloud — 12 min ago, 41 cookies, 6 origins, 2.1 MB · This machine — now, 44 cookies, 7 origins, 2.3 MB", with Keep cloud / Keep this machine / **Keep both (fork into a new profile)** — nearly free because chunks are already shared. The losing side is always retained.

**Per-profile `sync_mode='local-only'`** escape hatch (as Octo/Multilogin/GoLogin all ship): no lease, no cloud, faster open — but still the full local snapshot ledger, so "no cloud" never means "no backup".

**v1 ships single-user** (44 users / 44 teams / 44 memberships / 0 profiles). The lease, the version token and `RolesGuard` land now because they are schema-shaped and expensive to retrofit; per-member ADK re-wrapping (`team_key_wraps` row shape ready) gates behind a flag.

---
### 11. STARTUP AND LAUNCH

**Rule:** local-first render; the network blocks exactly one thing — **launching a profile against a superseded session**. Opening the app is not dangerous; launching stale cookies is.

**Cold open, target ≤250 ms p50 to an interactive list with the network unplugged:**
- `t=0` — Tauri `setup` does only: resolve paths, open `profiles.sqlite` (WAL), migrate, `app.manage`, create window, `Ok(())`. `SidecarClient::spawn` and `reconcile` become `tauri::async_runtime::spawn` (today two `block_on` calls at `lib.rs:1336-1339,:1346-1351`, and `sidecar.rs:123` has a 90 s timeout, so a wedged sidecar holds the hook). The keychain/LSK load moves off the hook into a `OnceCell` resolved lazily by its first consumer with a 2 s timeout (today `lib.rs:1281-1283` puts a possibly-prompting Secret Service call ahead of first paint).
- `t≈15 ms` — first paint **with content**: real shell + the last-rendered summary list persisted in `localStorage`, plus an "auth: checking…" chip. `App.tsx:82` and `EngineGate.tsx:67` stop withholding children — today `<div className="app-boot">` is background-only (`styles.css:2324-2327`) for up to the 15 s `/auth/me` timeout on a captive portal.
- `t≈40 ms` — **`list_profile_summaries`** (Molt's best idea, stolen wholesale): selects only `id, name, status, tags, folder, os, updated_at, sync_state, snapshot_version, snapshot_bytes, claim_holder`, `LIMIT 200` + cursor, behind `idx_profiles_list(trashed_at, updated_at DESC)`. **No encrypted columns ⇒ no `SecretCipher` and no keychain on the first-paint path.** Today `list()` is `SELECT *` with per-row AES decrypt, measured 55.4 ms at 2000 profiles, every 2 s. It no longer calls the sidecar and no longer propagates a sidecar error with `?` before reading the DB (`lib.rs:426-434`) — a dead sidecar must never cost read access to your own profiles. One cached `Intl.DateTimeFormat`, a proxy `Map` instead of a per-row scan, `react-window` above 100 rows.
- `t≈40 ms`, parallel and non-blocking: `GET /auth/me` (chip only, timeout 15 s→4 s), `GET /profiles/sync-state` (**one** request for the whole team — N head calls would 429 the account), sidecar `status`. Any failure leaves the app fully usable offline.
- `t≈200 ms` — badges settle (`synced` / `dirty` / `stale` / `conflict` / `needs_attention` / `In use — …`). SSE then keeps both live, **replacing the two unsynchronised full-list pollers** (2 s from `useProfiles.ts:59-67` with a main-thread `JSON.stringify` deep-compare, 8 s from `App.tsx:115-122`) with one Rust-emitted `profiles-changed` event plus a 30 s summary-only safety tick. That also kills the bug where the two copies disagree and Cmd-K fires `launch_profile` on an already-running profile for up to 8 s.
- `reconcile_profile_statuses` becomes read-only at startup (today two UPDATEs per reconcile at `profile_store.rs:584-610` bump `updated_at`, defeating the anti-flicker guard and reshuffling the default sort), and must stop blanket-idling a genuine prior `error` state.

**Launch, target ≤900 ms to window:**
1. In parallel from the click: `POST /profiles/:id/lease` and all local prep (fingerprint derivation, proxy resolution, extension provisioning). A 409 refuses before any work.
2. `snapshot_version == remote_version` (from sync-state, age ≤30 s, refreshed on focus) ⇒ **skip the network entirely**. The common case; +≈150 ms for one small round trip.
3. Stale ⇒ manifest → diff digests → pull only changed chunks → restore + verify → launch (0.3–3 s), behind an inline progress row, never a modal. Escape hatch: **"Launch the local copy anyway (may be an older session)"**, which marks the resulting snapshot as a **conflict**, not a push.
4. Local ahead (dirty) ⇒ capture-and-push first.
5. **Apply order: `identity` → file artifacts → spawn → cookies + tabs.** Cookies are injected **before first navigation** — resolving Molt's fatal flaw of overlapping cookie injection with the ~600 ms Chromium start while `--restore-last-session` is passed, which lets restored tabs make unauthenticated requests that can tear the session down server-side. Use `--no-startup-window` plus explicit tab creation after injection.
6. Remove the per-launch extension `rm -rf` + full re-extract (`extensions.ts:409-410,465-466`, unconditional from `:522,:535,:580`); key the unpacked dir by `sha256(crx)` and skip when present, as `fonts.ts:447-458` already does. Hundreds of ms off every launch on a 30 MB extension, and it stops silently overwriting in-place edits.
7. Bulk launch runs concurrently with a pool of 4 instead of `for..of await` (`ProfilesView.tsx:541-543`); bulk mutations batch into one refresh.

**Offline policy.** Local == last-known remote and the heads fetch is <10 min old with no other holder ⇒ launch under a locally recorded soft-lease, reconciled on reconnect. Local **behind** ⇒ refuse, with a plain explanation (launching a superseded jar can re-present an invalidated session and get the identity flagged). Local ahead ⇒ launch freely; the queue drains later.

**Stop.** Quiesce → quiesced capture of the full set → **local commit (staged, fsync'd, digested)** → enqueue push → release lease → push in background ("Backing up… / Backed up ✓ v17"). The lease is released **after** the local commit, so a crash between them lets the lease expire naturally rather than freeing the profile before its session is safely on disk. Returns to the UI in <150 ms; the upload is fire-and-forget.

**Crash recovery.** A profile whose row says `running` with no live process is a **crash**: its last 90 s autosave is intact and labelled `recovered`, and the UI says "Recovered a session snapshot from 14:31 (2 min before the crash)".

---
### 12. SCHEMA

**Postgres `profiles`:** ADD `snapshotVersion Int @default(0)`, `lastSyncedAt DateTime?`, `lastSyncedDeviceId String?`, `snapshotBytes BigInt @default(0)`, `manifestDigest String?`, `deletedAt DateTime?`, `syncMode String @default("cloud")`, `syncOptions Json @default("{}")`. DROP the dead `encryptedBlobRef`. RENAME `fingerprintSeed` → `fingerprintSeedDigest`. ADD `@@index([ownerTeamId, deletedAt])`, `@@index([ownerTeamId, updatedAt])`.

**New Postgres models:** `ProfileSnapshot` (`profileId, teamId, version, state pending|committed, manifestDigest, bytes, chunkCount, capturedAt, committedAt?, coherence, captureMode, engineBuild, deviceId, createdByUserId`, `@@unique([profileId, version])`, `@@index([profileId, state, version(desc)])`); `SnapshotArtifact` (`snapshotId, artifactId, digest, size, chunkDigests String[], fidelity full|cdp|stale, atRest oscrypt|plaintext, capturedAt, staleFromVersion?`, `@@id([snapshotId, artifactId])`); `SnapshotChunk` (`teamId, digest, size, refCount, createdAt`, `@@id([teamId,digest])`, `@@index([teamId, refCount])`); `ProfileLease` (`profileId @id, teamId, leaseId @unique, userId, deviceId, deviceLabel, acquiredAt, expiresAt, releasedAt?, revokedAt?, revokedByUserId?`, `@@index([expiresAt])`) **plus the raw-SQL partial unique index**; `Device` (`id, teamId, userId, label, platform, appVersion, engineBuild?, lastSeenAt, createdAt`); `AccountKeyEnrollment` (`userId @id, passwordSalt, recoverySalt, wrappedUkwkByUmk, wrappedUkwkByRk, kdfParams Json, enrolledAt, recoveryCodeUsedAt?, passwordRotatedAt?`); `TeamKeyWrap` (`teamId, userId, wrappedAdkByUkwk, adkKeyId, createdAt`, `@@id([teamId,userId])`).

**Local `profiles.sqlite`** — start using `PRAGMA user_version` and drive `migrate()` from it instead of the blind `ensure_column` ALTER chain (live value is 0; `profile_store.rs:187-236` is completely untested because every test builds a fresh DB from `SCHEMA`). Migration 0→1 adds to `profiles`: `snapshot_version`, `remote_version`, `local_rev`, `manifest_digest`, `identity_digest`, `dirty`, `sync_state`, `sync_mode`, `last_captured_at`, `last_synced_at`, `snapshot_bytes`, `sync_options`, `deleted_at`, `cookies_import_applied_at`, `dom_storage_backend` (`sqlite|leveldb|ambiguous|empty`), `oscrypt_mode` (`keychain|mock|pending-migration`), `lease_id`, `lease_expires_at`, `claim_holder`. New tables `snapshots`, `snapshot_artifacts`, `chunks(digest PK, size, rel_path, ref_count, uploaded_at)`, `sync_queue(… next_attempt_at)` + `idx_sync_queue_due`, `leases`, `account_keys(account_id PK, wrapped_adk_by_lsk, adk_key_id, password_salt, kdf_params, unlocked_at)`. New index `idx_profiles_list(trashed_at, updated_at DESC)`. **`clear_cookie_import` is DELETED** — the launch path sets `cookies_import_applied_at` and preserves `rawText`.

---
### 13. THE PLATFORM-CI PRECONDITION (all three designs' mitigations are currently vapour)

Every job in `.github/workflows/ci.yml` runs `ubuntu-latest`; there is **no `windows-latest` and no `macos-latest` runner**, and `product-e2e` appears in **no** workflow (`scripts/build-linux-product.sh:244` only prints `[warn] product-e2e failed — install is still present`, so a broken installer ships green). All three designs guard their most dangerous platform-specific changes with "a per-platform CI test asserts…". **Windows OSCrypt read/write, the macOS keychain migration and the DOM-storage probe must not ship until those runners exist and the round-trip is blocking on all three platforms.** This is Phase 1, not an afterthought.


---

## Implementation phases

Ordered so that **stopping at any phase boundary still leaves users better off than today**.
Phases 0–2 deliver "save cookies, localStorage and extensions" with no network at all.

### Phase 0 — Stop the bleeding: the answer-independent data-loss and ops fixes

**Goal.** Land every fix from immediateFixes. After this phase nothing in the product destroys user data on its own, an unlaunchable profile is recoverable in principle, production storage is honest, and the loopback API stops handing out live sessions. No new architecture, no schema beyond one local column and one Postgres column.

**Tasks.**

- profile_store.rs: delete clear_cookie_import; add cookies_import_applied_at column + mark_cookie_import_applied; update local_api.rs:254-261 to call it. Update the two existing tests at profile_store.rs:920-923.
- local_api.rs:190-196 + composite.ts:121-122 + ProfileList.tsx:502-514: remove the password gate and the running gate from the export/capture path.
- secrets.rs: delete decrypt_str; migrate profile_store.rs:250,254 and proxy_store.rs:90,101 to decrypt_strict; remove the .ok() swallow at :250,254 and the destroy-on-save at :263,268,472-476; add a typed SecretUnavailable error and a user-facing 'local secrets cannot be decrypted on this machine' state.
- lobium-launcher.ts: collapse the four Preferences writeFileSync calls into one writeAtomic(); delete the session.restore_on_startup writes at :495,:640; add SingletonLock/SingletonSocket/SingletonCookie removal beside clearDevToolsActivePort at :775.
- extensions.ts/lobium-launcher.ts: detect Default/Extensions entries at location:1 while --disable-extensions-except is active and surface a blocking UI warning naming them.
- local_api.rs:461-465: strip cookiesImport.rawText and decrypted proxy credentials from GET /api/v1/profile/list.
- AuthScreen.tsx:70: correct the 'Sign in to sync profiles' copy; wire the existing auth_sign_out (lib.rs:1473) and render the account chip.
- deploy/nginx/lobster-backend.conf: client_max_body_size 16m. main.ts: app.set('trust proxy', 1) + a global ApiExceptionFilter.
- profiles.module.ts:36-40: fail to boot on NODE_ENV=production && !S3_BUCKET. s3-blob-store.ts: ServerSideEncryption 'AES256', drop Metadata topology, fix blobRef to use the real bucket + S3_KEY_PREFIX. Set S3_* in the deployed env.
- prisma migration: profiles.deletedAt; repository.remove -> tombstone; deletedAt:null on every findMany/findById; lib.rs trash path calls remove_profile_data_dir.
- lib.rs: register RunEvent::ExitRequested to stop running browsers on quit.

**Exit criteria.** node:test suites for backend and packages green (`npm test -w apps/backend`, `npm test -w packages/engine-runner`, `npm test -w packages/crypto`) and `cargo test` green in apps/desktop/src-tauri. New tests prove: (1) launching a profile with a cookie import leaves rawText intact and sets cookies_import_applied_at; (2) capture succeeds on a stopped profile whose password hash is unknown; (3) a tampered lbsec1: cell now returns SecretUnavailable instead of the ciphertext string; (4) exactly one Preferences write occurs per launch and it is temp+rename; (5) GET /api/v1/profile/list contains no rawText and no proxy password; (6) backend boot throws with NODE_ENV=production and S3_BUCKET unset; (7) a deleted profile returns a tombstone and does NOT count toward assertCanAddProfiles. Manual: `curl -X POST -H 'Content-Type: application/json' --data-binary @2mb.json https://<host>/profiles/x/sync` returns a JSON envelope, not nginx HTML.

### Phase 1 — Platform CI foundation: make Windows and macOS provable

**Goal.** Create the runners and the blocking round-trip harness that every later phase's correctness claim depends on. Ships no product feature; ships the ability to prove one. This must precede any OSCrypt or DOM-storage work because all three source designs guard their riskiest changes with per-platform CI that does not exist.

**Tasks.**

- ci.yml: add windows-latest and macos-latest jobs running the Rust suite, the packages suites, and a new blocking `snapshot-roundtrip` job.
- Promote ci/validation/product-e2e.mjs into a workflow job and make it blocking; fix scripts/build-linux-product.sh:244 to exit non-zero.
- ci/validation/lib/fixture-site.mjs: a local HTTPS fixture server that sets a session cookie (incl. one partitioned and one __Host- cookie), writes a localStorage key, writes an IndexedDB record, and exposes GET /whoami returning logged-in|logged-out based on the cookie.
- ci/validation/snapshot-roundtrip.mjs: launch a real engine against a temp UDD, visit the fixture, assert logged in, quiesce, capture, wipe the UDD, restore into a FRESH dir, relaunch, assert /whoami still logged-in and the localStorage + IndexedDB values read back. Parameterised so later phases add cloud transport without rewriting it.
- ci/validation/asserts/paths.mjs: a path-drift detector that fails when a new entry appears under Default/ that is in neither the artifact allowlist nor a known-ignored list.
- ci/validation/asserts/oscrypt.mjs: on Windows assert Local State has os_crypt.encrypted_key and NO os_crypt.app_bound_encrypted_key after a real launch; assert the launcher always emits --user-data-dir.
- ci/validation/asserts/dom-backend.mjs: assert exactly one of Default/LocalStorage (file) or Default/Local Storage/leveldb (dir) exists after a launch.
- ci/validation/asserts/prefs.mjs: on Windows and macOS, launch twice and assert no preference_reset_time appears and Lobee still loads (this is the measurement that decides Phase 8's extensions.settings work).
- docker-compose CI service for MinIO; wire an S3BlobStore integration job asserting If-None-Match:'*' returns 412 and deleteAll behaves.

**Exit criteria.** A PR that deliberately breaks cookie persistence (e.g. reverts the atomic Preferences write, or copies LocalStorage's main file without its -wal) FAILS ci on all three platforms. `gh run list` shows windows-latest and macos-latest jobs. The MinIO job fails when If-None-Match is stubbed to be ignored. The path-drift detector fails when a fake Default/NewChromiumThing/ directory is added to the fixture.

### Phase 2 — Local snapshot engine and durable ledger (no cloud, no account keys)

**Goal.** Capture and restore the full artifact set locally, with verification and rollback, on all three platforms. This alone satisfies 'we have to save necessary data for users' — cookies, localStorage, extensions state — before any network exists. Encrypted under the existing LSK only, so it depends on nothing later.

**Tasks.**

- Add crates: blake3, zstd, snap, zeroize, ciborium, base32, rand; windows (Win32_Security_Cryptography) on Windows; security-framework on macOS.
- snapshot/manifest.rs: ArtifactSpec registry + canonical CBOR + BLAKE3; snapshot/mod.rs: capture/restore/verify entry points and CaptureMode {Quiesced, Live, Dirty}.
- snapshot/sqlite_copy.rs: vacuum_into() on a READ-WRITE handle with busy_timeout 2500ms, Backup fallback (512 pages x20, 250ms), assert_no_live_owner() reading SingletonLock + DevToolsActivePort with pid liveness.
- snapshot/dom_storage.rs: detect_backend() probe; raw-blob codec (base64 of exact map_entries key/value BLOBs, value_compression_type verbatim); LevelDB-dir tar path; restore builds a fresh DB from the verified DDL and REFUSES to cross backends.
- snapshot/idb.rs: per-file VACUUM INTO over Default/IndexedDB/<origin>/<Base32> (SQLite, verified) plus *.indexeddb.blob/ dir tar. Explicitly NOT a LevelDB path.
- snapshot/leveldb_tar.rs: whole-directory tar for Local/Sync Extension Settings, Extension State/Rules/Scripts, Service Worker — excluding LOCK/LOG/LOG.old, quiesced-only.
- snapshot/prefs.rs: KTRACKED_PREFS mirrored from chrome_pref_service_factory.cc:118-193 with a build-failing drift test; untracked-key allowlist extract + merge-on-restore.
- snapshot/tabs.rs, history (defensive on a missing `urls` table — prf_6d04dd17 raises it), bookmarks (ENOENT-tolerant, 0/9 profiles have it).
- identity artifact: serialise the profiles.sqlite row + proxies row + extension refs + font-pack id; capture lobium-fp.json as identity.resolved; on restore write the row, relaunch, regenerate, and DIFF against identity.resolved with a hard fail on divergence.
- Restore transaction: stage -> fsync -> integrity_check -> read-back through the capture codec -> digest compare -> move current files + sidecars to .lobster-pre-restore-<ts>/ -> atomic rename -> rollback on mismatch. Refuse engine downgrades.
- sidecar snapshot/quiesce.ts + a `quiesce` RPC; local_api stop path calls it before `stop`. 90s live autosave task. Crash detection on startup labelling the last autosave `recovered`.
- profiles.sqlite: PRAGMA user_version migration 0->1 with all new columns and the snapshots/snapshot_artifacts/chunks tables; a checked-in v0 fixture DB migrated in a test.
- UI: Snapshots panel per profile (list, capture now, restore, per-artifact counts, coherence badge); local-only mode toggle.

**Exit criteria.** snapshot-roundtrip.mjs passes on ubuntu, windows and macos runners using the LOCAL ledger only (capture -> wipe UDD -> restore from <appData>/snapshots -> relaunch -> /whoami logged-in, localStorage key present, IndexedDB record present). A test restores into a UDD with a deliberately corrupted staged artifact and asserts the pre-restore copy is put back and the report says so. A test migrates the checked-in v0 profiles.sqlite fixture and asserts every column and index exists. A test with a LevelDB-layout DOM store asserts capture uses the tar codec and a cross-backend restore is REFUSED with a named error. A test proves capture of prf_6d04dd17-shaped input (4 KB main + 28 KB -wal) yields the WAL contents, not the stale main file.

### Phase 3 — Cross-OS cookie, password and autofill portability

**Goal.** A snapshot captured on any OS restores logged-in on any other OS, and never logs the user out even when the target key is unreachable. Builds only on Phase 2's ledger.

**Tasks.**

- oscrypt/mod.rs: OsCryptKeyring trait, Aes128Cbc (IV=16x0x20, PKCS#7) and Aes256Gcm blob formats, the empty-password legacy retry key d0d0ec9c7d77d43ac54187fa4818d17f.
- oscrypt/linux.rs: v10 fixed key fd621fe5a2b402539dfa147ca9272778 (PBKDF2-HMAC-SHA1 'peanuts'/'saltysalt'/1/16); v11 keyring key decrypt-only via the existing keyring crate.
- oscrypt/windows.rs: read Local State os_crypt.encrypted_key, base64-decode, strip the 5-byte DPAPI prefix, CryptUnprotectData -> 32-byte AES-256-GCM key; CREATE and persist one when absent. No v20 path; v20 input is a named hard error OSCRYPT_APP_BOUND_UNSUPPORTED.
- oscrypt/macos.rs: real keychain reader (generic password, service 'Chromium Safe Storage', account 'Chromium', PBKDF2-HMAC-SHA1 1003 iterations, 16-byte key) behind an explicit one-time consent dialog; mock-keychain key PBKDF2('mock_password','saltysalt',1003,16); oscrypt_mode state machine keychain|mock|pending-migration.
- macOS migration command: quiesce -> read jar under the real key -> re-encrypt every row under the mock key -> read-back verify -> set oscrypt_mode='mock' -> only THEN pass --use-mock-keychain on subsequent launches. Never flag a profile in 'keychain' or 'pending-migration'.
- snapshot/cookies.rs: read all 20 v24 columns, refuse meta.version > 24, domain-hash key oracle (accept only the candidate key whose plaintext starts with SHA256(host_key)); restore writes v24 + cookies_unique_index with journal_mode=DELETE and re-encrypts under the target key; read-back verify before swap.
- Tier-2 fallback: when the target key is unreachable, write plaintext `value` with empty `encrypted_value` (verified loadable) and record atRest:'plaintext' in the manifest + UI.
- Tier-3 fallback: sidecar snapshot/storage-cookies.ts using Storage.getCookies/setCookies on the browser endpoint with full fidelity (partitionKey, sourceScheme, sourcePort, priority) and BINARY-SPLIT retry on rejection returning {injected, rejected[]}. Used when engineBuild major differs. Records fidelity:'cdp'.
- snapshot/vault.ts: network-incapable capture launch WITH --lobium-fp-config and FONTCONFIG_FILE; used for denied-keychain macOS capture and as a cross-check of the offline reader.
- snapshot/passwords.rs + autofill.rs on the same keyring (Login Data v43/compat 40; Web Data credit_cards behind a separate opt-in).
- cookie-inject.ts: migrate off deprecated Network.getAllCookies/setCookies to Storage.*; extend stealth-invariant.test.ts to cover the new helpers.

**Exit criteria.** A cross-OS matrix in CI: capture on ubuntu -> restore on windows -> /whoami logged-in; capture on windows -> restore on macos -> logged-in; and both reverse directions. Partitioned and __Host- cookies survive every leg. A Windows test captures cookies from a STOPPED, never-relaunched profile and restores them (proving gap [3] is fixed on the shipping platform). A macOS test asserts --use-mock-keychain is NEVER passed to a profile whose oscrypt_mode != 'mock', and that the migration re-encrypts then verifies before flipping. A key-unreachable test asserts the plaintext-value fallback loads and the manifest/UI say atRest:'plaintext'. A malformed-cookie test asserts binary-split injects the other 299 and the launch succeeds.

### Phase 4 — Account key (SIMPLIFIED — see the Correction section)

**Goal.** ~~An account password plus a recovery code can recover every profile's data on a brand-new machine.~~ **As built:** signing in is enough. `GET /vault/key` returns the account key, which derives a per-profile key. No enrollment step, no recovery code, no Argon2id.

**Tasks.**

- keys/mod.rs + enroll.rs + unlock.rs + recovery.rs: Argon2id m=65536/t=3/p=1/dkLen=32/salt16; UMK -> UKWK -> ADK ladder with LKw1 wraps; Crockford base32 recovery code (128 bits, 25 chars + checksum, normalisation I|L->1, O->0); enrollment does not complete until the code is typed back.
- Replace Argon2::default() at profile_store.rs:504,536 with the same params and SaltString::generate(&mut OsRng) instead of the UUIDv4-derived salt at :501.
- blob_crypto.rs: LBv2 envelope (magic|key_id|alg|aad_len|aad|nonce|ct|tag) with AAD = the full header prefix and aad = CBOR{accountId, profileId, artifactId, snapshotVersion, chunkIndex, chunkCount}; dispatch on magic so LBv1 stays readable; delete #![allow(dead_code)] and the sixteen-zero-byte key_id fallback at lib.rs:735-743.
- packages/crypto: mirror LBv2 + the v2 HKDF labels; add the profileId equality check to decryptProfileBlob (index.ts:210-231); write packages/crypto/test-vectors/lbv2.json as a shared KAT.
- Remove encrypt_profile_blob/decrypt_profile_blob from tauri::generate_handler! (lib.rs:1497-1498); add snapshot_capture/snapshot_restore/account_unlock commands taking no key material.
- secrets.rs: encrypt_cell/decrypt_cell with AAD '{table}/{id}/{column}'; move fingerprint_seed into the encrypt set; give template_store.rs a SecretCipher and retire its startup scrubber behind user_version.
- keychain.rs: stop mirroring the LSK to secrets.key on the keychain-hit path; DPAPI-wrap the fallback file on Windows; restrictive DACL replacing the #[cfg(unix)]-gated 0o600.
- Backend KeysModule: GET/PUT /keys/enrollment (idempotent-once, 409 unless a complete re-wrap set), POST /keys/rotate-password, POST /keys/recover. Server-side validation: wraps exactly 64 bytes starting LKw1, kdfParams not weaker than normative.
- Prisma: AccountKeyEnrollment + TeamKeyWrap models; profiles.fingerprintSeed -> fingerprintSeedDigest.
- UI: one 'Unlock your profiles' sheet for the ACCOUNT password (never a separate sync password), the recovery-code screen with copy/print/confirm and unhedged loss copy, and the 'I reset my password' path.
- Local account_keys table caching wrap_key(ADK, LSK) so day-2 opens need no password and no Argon2.

**Exit criteria.** The shared KAT gates CI: `npm test -w packages/crypto` and `cargo test` both read packages/crypto/test-vectors/lbv2.json and agree byte-for-byte. A test proves an LBv2 chunk from profile A fails to authenticate when its aad names profile B, when snapshotVersion is decremented, and when chunkIndex is swapped. A test proves the recovery code alone recovers the ADK on a fresh machine (fresh LSK) and that enrollment aborts if the code is not typed back. A grep-based test asserts no request body emitted by sync/client.rs contains the account password. A test asserts a second PUT /keys/enrollment with a different wrappedUkwk returns 409.

### Phase 5 — Cloud sync: manifest + content-addressed chunks

**Goal.** Snapshots replicate to the cloud incrementally and resumably, with required baseVersion, machine-readable conflict codes, tombstones and a scrubbed GC. The local ledger stays the durable copy. Depends on Phases 2-4 only.

**Tasks.**

- Prisma: ProfileSnapshot, SnapshotArtifact, SnapshotChunk models; profiles.snapshotVersion/lastSyncedAt/snapshotBytes/manifestDigest/syncMode/syncOptions; drop encryptedBlobRef; add the two ownerTeamId indexes.
- snapshots.controller/service: POST /profiles/:id/snapshots (required baseVersion, CAS UPDATE ... WHERE snapshotVersion=$2 returning the row; 409 profiles.stale_base_version WITH currentVersion), PUT chunks/:digest (idempotent, digest-verified over ciphertext, 400 profiles.not_encrypted unless LBv2), POST commit (pending->committed in one transaction), GET manifest/chunks with ETag+Range, POST /profiles/chunks/probe, GET /profiles/sync-state, GET /profiles/events (SSE).
- POST /profiles/bulk-adopt: create the server rows local profiles need. Handle assertCanAddProfiles 403 by naming which profiles are NOT backed up and offering the upgrade path; keep existing profiles syncing when a subscription lapses.
- sync/cas.rs: local content-addressed store at <appData>/snapshots/cas/<d0d1>/<digest> with ref_count PINNING and no prune before the committed ack.
- sync/client.rs + worker.rs: durable sync_queue drain, backoff 1s->300s with jitter, Retry-After, per-chunk resume via ETag/Range, <=2 PUTs / <=6 GETs / 8 MiB/s, never holding the sqlite mutex across an await, needs_attention with a surfaced reason after 12 attempts.
- Retention as a SEPARATE job (never inside push): last 10 committed + newest per day for 30 days. chunk-gc.service.ts (refCount==0, 90-day grace) plus chunk-scrub.service.ts re-verifying every retained manifest's chunks exist in S3 and alarming on gaps; pre-serve completeness check on GET manifest; S3 bucket versioning + 7-day soft delete.
- RolesGuard on remove / force-release / deleteAll; keep POST /profiles/:id/sync as a deprecated one-artifact shim.
- Conflict UI: side-by-side cloud vs local with cookie/origin counts and sizes, Keep cloud / Keep this machine / Keep both (fork), losing side always retained; plus <appData>/orphaned-snapshots/<profileId>-<ts>.lbsnap.

**Exit criteria.** Backend node:test suite (`npm test -w apps/backend`) covers: push without baseVersion is 400; a stale baseVersion returns 409 profiles.stale_base_version with currentVersion in the body; a non-LBv2 manifest is rejected; commit with a missing chunk returns 409 profiles.snapshot_incomplete and the version stays pending and unreadable; a deleted profile returns a tombstone and does not count toward the profile limit. The MinIO job proves two concurrent pushes cannot both succeed. A scrub test deliberately deletes a referenced chunk from MinIO and asserts the scrubber alarms and GET manifest refuses to serve. An offline test captures, crosses the CAS size cap, reconnects, and asserts the queue still uploads (ref_count pinning held).

### Phase 6 — Single-writer leases and holder identity

**Goal.** One profile can never be open on two machines, a crashed machine self-heals in <=150 s, and the UI names who holds a profile. Depends on Phase 5's version token.

**Tasks.**

- Prisma ProfileLease + Device models, plus a raw-SQL migration adding CREATE UNIQUE INDEX profile_leases_one_active ON profile_leases(profile_id) WHERE released_at IS NULL AND revoked_at IS NULL.
- leases.service.ts: single-statement CAS acquire (INSERT ... ON CONFLICT (profile_id) DO UPDATE ... WHERE expiresAt < now() OR revokedAt IS NOT NULL RETURNING *); renew; release; admin-only audited force-release setting revokedAt (never deleting the row).
- sync/lease.rs: acquire on launch, renew every 30s (TTL 150s), 30s grace with immediate retry on failure and on resume; on definitive loss QUIESCE AND STOP the browser, capture locally, write the .lbsnap orphan, and tell the user who took over.
- local_api.rs::start_profile_via_sidecar refuses to launch without a valid local lease row; composite.ts's 'already running' becomes a typed {code:'profiles.started'}.
- Reject any snapshot POST or commit presenting a revoked leaseId with 409 profiles.lease_revoked.
- UI: 'In use — alice@example.com on MacBook-Pro, since 14:02 (expires 14:07)' badge from sync-state + SSE, with Request release and admin Force release carrying a plain-language warning.
- Offline launch policy: soft-lease when local==remote and heads <10 min old with no other holder; REFUSE when local is behind; free when local is ahead.

**Exit criteria.** A backend test fires 20 concurrent acquires for one profile and asserts exactly one 201 and nineteen 409 profiles.in_use (the partial unique index makes a second active row physically impossible — assert the constraint violation directly too). A test asserts a lease whose expiresAt has passed is acquirable with no sweeper running. An integration test revokes a lease and asserts the runner stops the browser, writes an orphan .lbsnap, and that a subsequent push with the revoked leaseId returns 409 profiles.lease_revoked. A test asserts a renew failure with no recovery stops the browser rather than continuing unclaimed.

### Phase 7 — Startup and launch performance

**Goal.** Cold open to an interactive profile list <=250 ms p50 with the network unplugged, at any profile count; launch <=900 ms with sync contributing ~0 ms in the common case. Ships after sync so the badges it renders exist, but touches no sync semantics.

**Tasks.**

- lib.rs setup hook: keep only paths + sqlite open + migrate + manage + window; move SidecarClient::spawn (lib.rs:1336-1339), reconcile (:1346-1351) and the keychain load (:1281-1283) to tauri::async_runtime::spawn behind a OnceCell with timeouts.
- profile_store.rs: add list_profile_summaries selecting only unencrypted columns with LIMIT 200 + cursor, backed by idx_profiles_list(trashed_at, updated_at DESC). No SecretCipher on the first-paint path. Full rows fetched lazily on selection.
- lib.rs:426-434: degrade to local data on a sidecar error instead of propagating with ?.
- App.tsx:82 + EngineGate.tsx:67: stop withholding children on auth; render the shell plus a localStorage-persisted summary list in the first frame; /auth/me timeout 15s -> 4s, stale-while-revalidate.
- Collapse the 2s (useProfiles.ts:59-67, including its main-thread JSON.stringify) and 8s (App.tsx:115-122) pollers into one Rust-emitted profiles-changed event plus a 30s summary-only tick.
- reconcile_profile_statuses read-only at startup (drop the two UPDATEs at profile_store.rs:584-610 that bump updated_at); stop blanket-idling a genuine prior error state.
- ProfileList.tsx: one cached Intl.DateTimeFormat, a proxy Map instead of the per-row stored.find at :93, memoized rows, react-window above 100 rows.
- ProfilesView.tsx: bulk launch via a bounded pool of 4 instead of for..of await at :541-543; batch bulk mutations into one refresh.
- extensions.ts: key the unpacked dir by sha256(crx) and skip when present (the fonts.ts:447-458 pattern) instead of rm -rf + re-extract every launch; add a version/ETag/TTL check to the CRX cache at :473-499.
- Launch apply order enforced: identity -> file artifacts -> spawn with --no-startup-window -> cookies -> tabs. Cookies land BEFORE first navigation.
- vite.config.ts / NewProfileForm.tsx:3: stop dragging catalog.generated.ts (3.4 MB) into the lazy chunk.

**Exit criteria.** A CI timing gate asserts cold open to list-interactive <=250 ms p50 over 20 runs with the network blackholed, at a seeded 2000-profile DB, and fails the build above 400 ms p95. A gate asserts no Argon2 call and no keychain read occurs on the first-paint path (instrumented counter). A test asserts list_profile_summaries issues zero decrypt calls. A test asserts cookies are injected before any navigation occurs (fixture server records request order and sees no unauthenticated request). A test asserts a second launch of an unchanged 30 MB extension performs no re-extract.

### Phase 8 — Extensions: make 'and extensions' true

**Goal.** User-installed extensions load, their IDs are stable and real, and extension-state sync stops being fidelity:'stale'. This is the last phase because it needs the fork decision the owner has not made, and because its Windows/macOS pref question is measured in Phase 1.

**Tasks.**

- Resolve the owner question: either drop --disable-extensions-except (surrendering the 'only our extensions run' guarantee) or patch the fork's disable_flag_exempted_extensions_ to include user installs. Implement whichever is chosen.
- extensions.ts:355-415: inject the CRX3 header public key as the manifest `key` so IDs become the real CWS IDs, fixing chrome.identity OAuth and externally_connectable and making extension state shareable across profiles.
- One-time remap migration for profiles carrying path-derived IDs: prf_c30fea6b pins TWO IDs at the same lobee path with two Local Extension Settings dirs, so the pre-key ID's state is stranded and must be merged or explicitly abandoned with a report.
- extension-state artifact promoted from fidelity:'stale' to 'full': keyed by manifest extension ref, remapped to the local on-disk ID on apply, orphans reported rather than silently left.
- Resolve the extensions.settings tracked-pref question using Phase 1's prefs.mjs measurement: if the write trips enforcement on Windows/macOS, move Lobee loading entirely onto command-line flags and stop touching the pref.
- Prune lobium-extensions/ snapshots and extensions.pinned_extensions; never re-extract in place over a user's edits.
- Enable the serviceworkers artifact by default once a fixture proves an SW-backed offline login survives capture/restore.

**Exit criteria.** An e2e test installs an extension from inside the browser, asserts it appears in chrome://extensions and runs, captures, restores into a fresh UDD on another platform, and asserts the extension's chrome.storage.local value reads back under the SAME extension ID. A test asserts a web-store extension's ID equals its real CWS ID and is identical across two profiles. The Phase 1 prefs.mjs gate stays green on Windows and macOS after the extensions.settings change.

---

## End-to-end test plan

The owner asked for e2e tests on completion. These are the tests; #1 is the one that
matters most.

### 1. `cross-machine-restore-still-logged-in (THE proof test)`

**Proves.** The product's core promise end to end: a real logged-in Lobium profile is snapshotted, the profile is destroyed, and a restore on a DIFFERENT machine identity opens with the site still considering the user logged in — cookies, localStorage AND IndexedDB — with the same browser fingerprint.

**How.** New `ci/validation/cross-machine-restore.mjs`, run as a blocking matrix job on ubuntu-latest, windows-latest and macos-latest (added in Phase 1). Steps: (1) start `ci/validation/lib/fixture-site.mjs`, a local HTTPS server that on POST /login sets a session cookie (plus one partitioned CHIPS cookie and one __Host- cookie), has the page write a localStorage token and an IndexedDB record, and answers GET /whoami with logged-in|logged-out from the cookie alone; (2) create a profile through the real Rust core, launch the real engine, log in, assert /whoami == logged-in and read back the localStorage + IndexedDB values; (3) `snapshot_capture` in Quiesced mode; (4) push to a MinIO-backed backend started by the CI docker-compose service, with S3_BUCKET set; (5) simulate a different machine: wipe the user-data-dir AND delete the local ledger AND delete the OS keychain LSK entry AND clear profiles.sqlite, then unlock with the account password (or, in a second variant, with ONLY the recovery code) to re-derive the ADK; (6) pull, restore into a FRESH user-data-dir, relaunch; (7) assert GET /whoami == logged-in, the localStorage token and IndexedDB record are byte-identical, and the regenerated lobium-fp.json diffs clean against identity.resolved (canvas/webgl/audio/mediaDevices seeds, resolved font family list, net.proxy and webrtcPolicy). Cross-OS legs upload from one runner and download on another via a CI artifact so ubuntu->windows and windows->macos are both exercised. Wire it as a job in .github/workflows/ci.yml; failure blocks merge.

### 2. `snapshot-roundtrip-local (per-platform, no cloud)`

**Proves.** The snapshot engine itself is lossless and the artifact allowlist is complete, independently of keys and network — so a Phase 2 regression is caught without Phase 4 or 5.

**How.** `ci/validation/snapshot-roundtrip.mjs` on all three runners: launch -> fixture login -> capture -> wipe UDD -> restore from the LOCAL ledger only -> relaunch -> assert cookie + localStorage + IndexedDB + saved password + a site permission all read back. Includes the WAL-trap case: build a LocalStorage with a small main file and a large unmerged -wal (the prf_6d04dd17 shape, 4096 B main / 28872 B wal) and assert the captured content is the WAL state, not the stale main file. Also asserts a per-file IndexedDB SQLite copy (not a LevelDB tar) by checking the restored file's header bytes and table list.

### 3. `restore-rollback-on-corruption`

**Proves.** A failed restore never destroys the local copy — the shared fatal flaw in Molt and Warm Restore.

**How.** Rust integration test in `apps/desktop/src-tauri/src/snapshot/mod.rs` (run by `cargo test`): build a valid snapshot, then inject a fault so a staged artifact fails its read-back digest compare (truncate the staged Cookies file, and separately simulate ENOSPC). Assert the original Cookies/-wal/-shm are restored from `.lobster-pre-restore-<ts>/`, the profile still opens logged in, and RestoreReport names the failed artifact. Repeat with a process kill between stage and rename.

### 4. `macos-oscrypt-mode-safety`

**Proves.** The verified macOS session-loss trap is closed: --use-mock-keychain is never applied to a profile holding ciphertext under the real keychain key.

**How.** macos-latest job in ci.yml. (a) Launch a profile with no flag, log in, assert cookies decrypt under the real keychain key; assert the launcher did NOT pass --use-mock-keychain and oscrypt_mode=='keychain'. (b) Run the migration command; assert every row was re-encrypted and read-back verified BEFORE oscrypt_mode flipped to 'mock'; relaunch with the flag and assert /whoami == logged-in. (c) Force the migration to fail mid-way; assert oscrypt_mode stayed 'keychain', the flag is still not passed, and the profile opens logged in. (d) Deny keychain consent; assert capture falls back to the vault launch and restore uses the plaintext-value tier with atRest:'plaintext' surfaced.

### 5. `windows-offline-capture-of-a-stopped-profile`

**Proves.** Gap [3] is fixed on the shipping platform — an unlaunchable Windows profile IS recoverable, contradicting Molt's premise.

**How.** windows-latest job. Launch, log in, quiesce, then break the profile so it cannot launch (point it at a dead proxy and corrupt DevToolsActivePort). Run `snapshot_capture` in Dirty mode with no engine running and no profile password available. Assert cookies were read via DPAPI v10 and the count matches the pre-break jar. Separately assert `Local State` contains os_crypt.encrypted_key and NO os_crypt.app_bound_encrypted_key, and that the launcher always emits --user-data-dir (the guard that keeps v20 unreachable).

### 6. `dom-storage-backend-probe-and-refusal`

**Proves.** Both DOM-storage backends are handled and a cross-backend restore fails loudly instead of transferring nothing — the gap [5] silent-zero-transfer class.

**How.** `node --test packages/engine-runner` plus a Rust test. Construct two fixture profiles: one with `Default/LocalStorage` (SQLite) and one with `Default/Local Storage/leveldb/`. Assert detect_backend classifies each, capture uses the matching codec, a restore across backends is REFUSED with a named error, and an ambiguous profile (both present) is refused. Plus the Phase 1 `dom-backend.mjs` assertion that exactly one exists after a real launch, so a field-trial flip fails a test rather than shipping.

### 7. `lbv2-known-answer-tests-and-aad-binding`

**Proves.** Rust and TypeScript crypto agree byte-for-byte, and ciphertext is not transplantable — closing gap [18] and the interop risk both designs left to human inspection.

**How.** `packages/crypto/test-vectors/lbv2.json` read by BOTH `npm test -w packages/crypto` (node:test) and a `cargo test` in `blob_crypto.rs`; required CI gate. Assert identical output for fixed ADK/accountId/profileId inputs across PCK, key_id, artifact key and chunk key/nonce. Negative cases: a chunk whose aad names a different profileId, artifactId, a decremented snapshotVersion, or a swapped chunkIndex all fail authentication; decryptProfileBlob rejects a payload whose profileId differs from the requested one.

### 8. `lease-exclusivity-under-concurrency`

**Proves.** Two machines can never both hold a profile, and a crashed machine self-heals — resolving Warm Restore's missing-CAS flaw.

**How.** `npm test -w apps/backend` (node:test) against a real Postgres in CI: fire 20 concurrent POST /profiles/:id/lease and assert exactly one 201 and nineteen 409 profiles.in_use; separately attempt a direct INSERT of a second active row and assert the partial unique index rejects it. Assert a lease whose expiresAt has passed is acquirable with no sweeper running. Integration: revoke a lease and assert the runner quiesces, captures locally, writes the orphan .lbsnap, and that a push with the revoked leaseId returns 409 profiles.lease_revoked.

### 9. `sync-protocol-conflict-and-partial-upload`

**Proves.** No silent clobbering, no readable half-uploaded snapshot, and no plaintext accepted as encrypted.

**How.** `npm test -w apps/backend`: push without baseVersion -> 400; stale baseVersion -> 409 profiles.stale_base_version with currentVersion in the body; a manifest not starting LBv2 -> 400 profiles.not_encrypted; commit with a missing chunk -> 409 profiles.snapshot_incomplete with the missing digests, and the version remains pending and invisible to GET /profiles/:id/snapshots; a chunk PUT whose bytes do not match its digest -> 400 profiles.digest_mismatch. Plus the MinIO integration job asserting If-None-Match:'*' returns 412 so two concurrent pushes cannot clobber, and that deleteAll works against a real S3 API (zero coverage today).

### 10. `chunk-gc-scrub-and-offline-queue-durability`

**Proves.** The GC cannot silently gut retained snapshots, and an offline machine never loses a queued capture — resolving Molt's LRU-eviction flaw and both designs' unmonitored GC.

**How.** Backend node:test: seed snapshots sharing chunks, run the GC, and assert every retained manifest's chunks survive; then delete a referenced chunk directly from MinIO and assert chunk-scrub alarms and GET manifest refuses to serve an incomplete snapshot. Rust test: capture, then push the local CAS past its size cap while offline, then reconnect and assert the queue still uploads successfully (ref_count pinning prevented eviction) and that nothing local was pruned before the committed ack.

### 11. `startup-and-launch-performance-gates`

**Proves.** The 'rapid' half of the requirement is enforced mechanically, and sync never regresses it.

**How.** A CI timing job seeding a 2000-profile profiles.sqlite with the network blackholed: assert cold open to list-interactive <=250 ms p50 over 20 runs and fail above 400 ms p95. Instrumented counters assert zero Argon2 calls, zero keychain reads and zero SecretCipher decrypts on the first-paint path. A launch test asserts the in-sync path performs no chunk GETs, and the fixture server asserts no unauthenticated request arrives before cookie injection (proving apply order identity -> files -> spawn -> cookies -> tabs).

### 12. `local-sqlite-migration-over-a-real-v0-fixture`

**Proves.** An app update against an existing profiles.sqlite does not break the profile list for every existing user — the case gap [26] says no current test can catch.

**How.** Check in a real pre-migration `profiles.sqlite` (pragma user_version = 0, captured from this machine and scrubbed) as a test fixture. `cargo test` opens it, runs init()/migrate(), and asserts user_version advanced, every new column and index exists, existing rows are readable, and the newly-encrypted fingerprint_seed round-trips. A second case asserts a profile whose LSK is unavailable surfaces SecretUnavailable and the documented recovery flow rather than a silent NULL overwrite.

### 13. `path-drift-and-tracked-pref-drift detectors`

**Proves.** The allowlist's inherent failure mode — Chromium moving or adding an artifact — fails a test instead of silently syncing nothing.

**How.** Two gates. (1) `ci/validation/asserts/paths.mjs`: after a real launch, enumerate Default/ and fail on any entry in neither the artifact allowlist nor the known-ignored list; verify by adding a fake Default/NewChromiumThing/ to the fixture and asserting the job fails. (2) A Rust test comparing snapshot/prefs.rs's KTRACKED_PREFS against chrome_pref_service_factory.cc:118-193 in the pinned fork checkout, failing the build when upstream moves. Plus the Windows/macOS prefs.mjs gate asserting two launches produce no preference_reset_time.

---

## Residual risks we knowingly accept

- SCALE. This is 8 phases and roughly 20 new Rust modules, 4 sidecar modules, 7 new Postgres tables, ~10 new local tables/columns sets, 3 new backend modules and a new CI matrix on two platforms that do not exist yet. Realistically several months of focused work, not weeks. Phases 0-2 alone (the ones that actually stop data loss and deliver 'save users' cookies, localStorage and extensions') are a substantial slice, and every phase after 2 is additive value on top of a product that already stops losing data. The plan is deliberately ordered so that stopping halfway still leaves users better off than today. Do not compress Phase 1 — every platform-specific correctness claim in Phases 3, 4 and 8 is unverifiable without it, and all three source designs guarded their riskiest changes with CI that does not exist.

- COOKIE PORTABILITY IS ALSO ATTACKER PORTABILITY. Making Windows DPAPI and macOS keys readable to our own process, and the macOS mock-keychain path constant, means Default/Cookies and Default/Login Data are effectively plaintext to any same-user process, file-level backup, or cloud-synced folder — the posture Linux already has via --password-store=basic (gap [16]). This is a deliberate consequence of binding decision #3 ('cookies are decrypted at capture time'). Partial mitigations only: the snapshot is LBv2-encrypted under the account root key, secrets.key stops being an unconditional LSK mirror, and the profiles directory gets a restrictive Windows DACL. Full-disk encryption is the real control and the docs must say so, with a named owner for this accepted risk.

- PER-ARTIFACT CONSISTENCY IS NOT CROSS-ARTIFACT CONSISTENCY, and we expose that rather than solve it. Chromium has no cross-store transaction, so a live 90 s autosave can hold Cookies@T1 with localStorage@T2; a site that cross-checks a cookie against a localStorage token can read the mismatch as a hijack signal. Only Quiesced capture is truly consistent. Mitigated by stamping coherence:{windowMs}, labelling >2000 ms as loose, always taking a quiesced capture on stop, and defaulting the restore UI to the newest QUIESCED snapshot — but the risk is reduced, not eliminated.

- FORGOTTEN PASSWORD PLUS LOST RECOVERY CODE IS PERMANENT, UNRECOVERABLE LOSS of every synced session. This is the direct cost of binding decision #2 and it will generate angry tickets. Stated in plain words at enrollment behind a required confirmation; support can offer only enrolledAt and recoveryCodeUsedAt. Separately confusing and accepted: a web password reset does NOT rotate the vault, so the unlock password can silently diverge from the sign-in password until the user re-wraps.

- THE ALLOWLIST'S FAILURE MODE IS SILENCE. It removes the denylist's re-inflation risk (gap [14]) and adds the opposite one: a Chromium change that MOVES a real artifact — as 152 just did with DOM storage, and as the DomStorageSqliteNewDatabases field trial can still do per-profile-directory — makes us sync nothing from it with no error. Mitigated mechanically by the path-drift detector, the backend probe, the tracked-pref drift test and the blocking round-trip, but a genuinely new storage location that no test knows to look for will be missed until a user reports it.

- THE 150 s LEASE CAN BE TAKEN FROM A LIVE BROWSER. A merely network-partitioned machine — not crashed — can have its profile claimed while its browser is still open and writing. Authoritative revocation closes the split-brain (the revoked runner stops and refuses to commit) but only after up to 30 s of continued browsing whose snapshot lands as a conflict rather than a sync. Nothing is lost (it is captured locally and offered as a conflict, plus written as a named .lbsnap), but the user is interrupted. A shorter TTL trades false takeovers for slower crash recovery; 150 s is a judgement call to revisit with real telemetry.

- OPAQUE ARTIFACTS ARE ONLY CHECKSUM-VERIFIED, NOT CONTENT-VERIFIED. A VACUUM INTO of an IndexedDB file proves the copy is valid SQLite, not that the object stores inside are coherent; a tar of Local Extension Settings/<id> proves nothing about LevelDB internal consistency. For those artifacts 'verified' means 'byte-identical to what we captured', which is weaker than the guarantee cookies and DOM storage get. Mitigated by capturing LevelDB artifacts quiesced-only and distinguishing fidelity full|cdp|stale in the manifest, so the difference is legible rather than implied.

- ENGINE VERSION IS PART OF THE PAYLOAD CONTRACT. A cookie DB written at v24 and opened by an engine expecting v25 triggers Chromium's own migration on a foreign-written DB, whose behaviour is untested; the reverse (restoring into an older engine) makes Chromium raze a too-new DB and lose every cookie. We refuse downgrades outright and route cross-major-build restores through the CDP tier, accepting the loss of four metadata columns with no CDP representation (creation_utc, last_access_utc, last_update_utc, source_type). Pin the engine build across a sync pair wherever possible; a mixed-version fleet remains a real support burden.

- DETERMINISTIC CHUNK KEYS GIVE AN INTRA-TEAM EQUALITY ORACLE. A server operator can observe that two profiles in the SAME team contain an identical chunk. Cross-team correlation is impossible because the key derives from that team's ADK. This is a deliberate trade for the incrementality that makes sync invisible and must be written into docs/OPERATIONS.md rather than discovered later.

- TWO MIGRATIONS RUN AGAINST REAL USER DATA WITH LIMITED REHEARSAL. The local SQLite upgrade path is untested today (every test builds a fresh DB from the SCHEMA constant, live user_version is 0), and we are simultaneously moving fingerprint_seed into the encrypted set and deleting the fail-open decrypt_str — so any profile whose LSK was lost now surfaces a hard SecretUnavailable where it previously (wrongly) appeared to work. Mitigated by a checked-in real v0 fixture DB in CI and an explicit user-facing recovery flow, but the first update against a genuinely old install is still the riskiest moment in the plan.

- EXTENSION STATE SYNC IS A PROMISE WE CANNOT KEEP UNTIL PHASE 8. --disable-extensions-except means user-installed extensions never load, and path-derived IDs mean a restored Local Extension Settings/<id> can land orphaned (proven on disk: prf_c30fea6b pins two IDs at the same lobee path with two settings dirs). Until the fork decision lands, extension-state is captured but flagged fidelity:'stale' and the UI does NOT promise extension logins survive. The product owner's 'and extensions' is only fully satisfied at Phase 8.

- sessionStorage IS ONLY RESTORED SAME-MACHINE. session_metadata.session_id is the per-run SNSS namespace id, so cross-machine restore drops it and records reason:'namespace-ids-not-transferable'. Sites that keep a token only in sessionStorage will open logged out after a cross-machine restore. This is honest rather than fixable; pretending otherwise would be the silent half-session this design exists to avoid.

- SERVICE WORKER STATE SHIPS OFF BY DEFAULT and the brief flags it as potentially carrying offline auth. A SW registration restored without its matching Cache Storage can be worse than absent, and we exclude the caches deliberately as re-fetchable. It stays off until a fixture proves an SW-backed offline login actually survives a round trip — accepted as a known gap in 'everything we should save'.

- THE FREE-TIER PROFILE LIMIT MEANS SOME PROFILES ARE LEGITIMATELY UNSYNCED. assertCanAddProfiles caps a free team at 3 while this box alone has 9 local profiles, so bulk-adopt will 403 partway. We surface exactly which profiles are not backed up and why rather than failing opaquely, but the honest product answer is that free users' extra profiles are local-only — and the ledger must be good enough that local-only is still a real backup.


---

## Phase 1 implementation record — what the platform CI runners actually cover

Landed for Phase 1: the `cross-platform` job in `.github/workflows/ci.yml` (matrix `windows-latest` + `macos-latest`, `fail-fast: false`), `ci/validation/cross-platform-suite.mjs`, an opt-in `product-e2e` job, and a blocking `product-e2e` in `scripts/build-linux-product.sh`. This section records the boundary precisely, because the value of Phases 3, 4 and 8 depends on knowing which of their platform claims a green CI actually supports.

**Covered on Windows and macOS.** `npm run typecheck --workspaces` (including the backend against a generated Prisma client); the node:test suites of `@lobster/crypto`, `@lobster/fingerprint`, `@lobster/proxy`, `@lobster/cookies`, `@lobster/agent`, `@lobster/engine-runner`, `@lobster/lobee-app` and `@lobster/local-api-sdk`, run file-by-file by `ci/validation/cross-platform-suite.mjs` rather than by shell globbing; and `cargo check --lib --all-targets` in `apps/desktop/src-tauri`, which compiles every `cfg(windows)` / `cfg(target_os = "macos")` block — the code paths that had never been compiled by any automated run. The suite script also builds `packages/engine-runner/dist`, so the sidecar the Rust tests spawn exists.

**Excluded, by name and reason.** `ci/validation/cross-platform-suite.mjs` holds the list; each entry fails the run if it stops matching a real file, so a rename cannot silently retire a suite.

- `runners/lobium-launcher.test.js` does not run on Windows. `src/runners/lobium-launcher.test.ts:310` asserts `stat().mode & 0o777 === 0o600` on the atomically-rewritten `Preferences`; Windows maps `mode` onto the read-only attribute alone, so it reads back `0o666`. This is the least comfortable exclusion in the list — the launcher is the most platform-sensitive module in the tree. `lobium-config.test.ts:251` and `agent/journal/store.test.ts:35` already show the fix (assert `mode & 0o200` on `win32`); the exclusion should be deleted with it.
- `agent/journal/store.test.js`, `agent/upload.test.js` and `engine-runner/extensions.test.js` are skipped **only if** the runner cannot create a symbolic link. Windows needs `SeCreateSymbolicLinkPrivilege`, which we cannot verify from here, so the script probes it and prints exactly what it dropped; on a runner that has the privilege nothing is skipped. A non-Windows runner that cannot symlink fails the job instead.
- `apps/backend`'s suite runs only on Linux. It ships as a Linux container and has no platform-conditional code, so the minutes buy no platform signal.
- `cargo test --lib` does not run on Windows: `engine_provision.rs:301` installs a `chrome` that `engine_present` looks for as `chrome.exe` (`lib.rs:196`), and `sidecar.rs:191` spawns `true`, which is not an executable there. Both are test-fixture assumptions, not product bugs.
- `cargo test --lib` on macOS runs `continue-on-error: true`, because that suite has never executed on macOS anywhere. Promoting it is deleting one line, and it should be promoted after its first green run rather than left advisory.

**NOT covered anywhere, still.** No CI on any platform launches a browser and proves a profile's data survives, because `ci/validation/product-e2e.mjs` refuses to start without `LOBSTER_FONTS_DIR` (`product-e2e.mjs:142`) and wants a real engine, neither of which a github-hosted runner has. It is therefore wired as the opt-in `product-e2e` job (`vars.LOBSTER_ENABLE_PRODUCT_E2E`), which is blocking the moment it is enabled and fails rather than skips if the font pack is missing. On Linux it is now blocking inside `scripts/build-linux-product.sh`: a failed E2E stops the script instead of printing `[warn]` and going on to announce a finished product, and it is bounded by `timeout` because an early throw leaves the fixture server holding the event loop open — verified by running it with `LOBSTER_FONTS_DIR` unset, where it printed its error and then had to be killed. That hang is fixed at the source too (`main().catch` now exits rather than setting `process.exitCode`).

The snapshot round-trip itself is a real, blocking step in the `cross-platform` job today that reports `PENDING` and exits 0 while `ci/validation/snapshot-roundtrip.mjs` does not exist. Committing that file turns the gate on with no workflow edit. Until then, and this is the honest state of Phase 1: **nothing proves that a captured profile restores on Windows or macOS** — the OSCrypt asymmetry in §4 and the `Local State` finding in the taxonomy remain unmeasured, as do `asserts/paths.mjs`, `asserts/oscrypt.mjs`, `asserts/dom-backend.mjs`, `asserts/prefs.mjs` and the MinIO `S3BlobStore` job.

**What is unverified in the runners themselves.** GitHub Actions cannot be executed from the development box, so every step was reasoned about against the real code and, where possible, executed locally on Linux (the suite script runs green with nothing skipped, and its Windows-exclusion, missing-capability and stale-exclusion paths were each exercised by forcing them). What remains genuinely unproven until the first run: whether `npm install` resolves the platform-specific optional binaries from a Linux-generated lockfile on both images, whether the Windows runner grants symlink privilege, whether `cargo check` finds a usable MSVC/WebView2 and Xcode toolchain, and whether `cargo test --lib` passes on macOS. The first red run of this job is expected to be about one of those, not about profile data.

## Identity: what makes a restore a recovery rather than a new device

Added after the Phase 2 verification found that the manifest recorded the session but not the browser
it came from — the design's only `required: YES` artifact was missing, so a restore reinstated the
data while proving nothing about the device presenting it.

**Identity lives in the profile ROW, not the user-data-dir.** `writeLobiumConfig` rewrites
`lobium-fp.json` from the row's seed, overrides and proxy geo on *every* launch
(`packages/engine-runner/src/lobium-config.ts`), so anything a snapshot copied out of the directory
would be overwritten before the browser read it. The manifest therefore carries an `identity` block
built from the row: engine, OS, OS version, fingerprint seed, a *digest* of the overrides (so the
manifest proves sameness without carrying persona detail), whether a proxy was bound, the proxy's
host:port, and the engine build.

`restore` compares that against the profile it is restoring *into*, before anything is staged or
parked, and refuses on any blocking difference:

| Difference | Behaviour | Why |
|---|---|---|
| engine, OS, OS version, seed, or overrides digest | **Refuse** | The restored profile would present a different device for the same account. |
| Proxy present at capture, absent now | **Refuse** | `lobium-config.ts:186-187` derives `webrtcPolicy` from proxy presence: with none it falls back to `default_public_interface_only`, exposing host ICE candidates while the persona still asserts its original timezone. Losing the proxy turns on a host-IP leak, not merely a different exit. |
| Proxy endpoint changed | **Report** | Rotating a residential exit is routine and user-initiated. Blocking it would lock people out of their own sessions. |
| Restoring into an *older* engine build | **Refuse** | Chromium migrates its own databases forward but razes one that is too new. A newer target is fine. An unparseable build string never manufactures a refusal. |

`force` overrides a blocking refusal, for the one legitimate case — a user who knowingly rebuilt the
persona and wants the cookies anyway. It is never the default, and mismatches are reported either way.

## Phase 3 as built: cross-OS secret portability

Every parameter below was read from the fork source, not recalled, because a wrong constant here logs
users out silently rather than failing.

| Platform | Key source | Cipher | Value layout |
|---|---|---|---|
| Linux | Fixed constant `fd621fe5a2b402539dfa147ca9272778` — PBKDF2-HMAC-SHA1(1 iter, "peanuts", "saltysalt") | AES-128-CBC, IV = 16 × `0x20` | `v10 ‖ ciphertext` |
| Windows | `Local State` → `os_crypt.encrypted_key`, base64 of `"DPAPI" ‖ CryptProtectData(key)`; unwrap with `CryptUnprotectData`, must be exactly 32 bytes | AES-256-GCM | `v10 ‖ nonce(12) ‖ ciphertext ‖ tag(16)`, empty AAD |
| macOS | Keychain generic password, service `Chromium Safe Storage` / account `Chromium`; PBKDF2-HMAC-SHA1(**1003** iters, salt `saltysalt`) → 16 bytes | AES-128-CBC | `v10 ‖ ciphertext` |

**Cookie values are domain-bound.** At cookie schema v24 the plaintext is `SHA256(host_key) ‖ value`.
Verified on disk: **873 of 873** real encrypted values across nine profiles carry that prefix. The
codec therefore strips it at capture and *recomputes it for the target host* on re-seal — a naive
implementation that carried the prefix verbatim would produce cookies Chromium rejects. The same
property is used as a key oracle: a candidate key is accepted only when its output starts with the
correct domain hash, so a wrong key, a tampered row, or a row transplanted from another host all
reject by construction instead of yielding a plausible-looking wrong value.

**Windows is v10, not v20.** `GetAppBoundEncryptionSupportLevel` returns `kNotSystemLevel` unless
`IsSystemInstall()` and `kNotUsingDefaultUserDataDir` when the data dir is overridden. Lobster is a
per-user NSIS install that always passes `--user-data-dir`, so either condition alone forces
`UseForEncryption()` false. No v20 value is ever written by our build, and a v20 value encountered on
import is the named hard error `OSCRYPT_APP_BOUND_UNSUPPORTED` rather than a silent skip.

**When the target key is unreachable**, behaviour differs by artifact because the fork's fallbacks do:

- **Cookies** fall back to the plaintext `value` column with `encrypted_value` empty. This was
  confirmed loadable in the fork rather than assumed, and the manifest records `atRest: plaintext` so
  the state is legible rather than hidden.
- **Passwords and autofill** are **not written at all** and reported as skipped. There is no plaintext
  fallback for them, and writing source-key ciphertext cross-OS causes blanking or purging — so the
  honest outcome is to leave the target untouched and say so.

**The macOS `--use-mock-keychain` trap** is guarded. Chromium matches ciphertext by provider tag
prefix; the mock key and the real Keychain key both use tag `v10`; a tag match with a key failure is a
*permanent* failure with no alternate-key retry, and the cookie row is then dropped. The flag is
therefore refused for any profile still holding real-Keychain ciphertext, and a per-profile
`oscrypt_mode` (`keychain` | `mock` | `pending-migration`) records where a profile is in that
migration.

### Proven, not asserted

- **873 / 873** real cookie values decrypt under the host key.
- **873 / 873** survive a change of platform key: captured under Linux AES-128-CBC, re-sealed under an
  AES-256-GCM key (the Windows shape), each proven *unreadable* under the source key and byte-identical
  in plaintext under the target. That is the cross-machine move, executed on real data.
- All **9** real profiles round-trip capture → destroy → restore.
- Test scratch directories are removed on panic and early return via a `Drop` guard. This is a
  security control, not tidiness: the real-profile tests copy a live user-data-dir into `/tmp`, the
  Linux key is a public constant, and one such directory was found holding 181 real cookie values.

## Blob storage: this server's own disk

Phase 5 was briefly written off as blocked on S3 credentials. That was too narrow a reading of the
problem. The backend depends on a four-method `BlobStore` interface over **opaque bytes** — the
desktop client encrypts before upload, so the server could not read a blob if it wanted to. Object
storage was never a requirement; durability and atomicity were. A directory on the server provides
both, with no external dependency and no credentials to manage.

`FilesystemBlobStore` is therefore a first-class production choice, selected by `BLOB_STORE_PATH`.
Precedence is `S3_BUCKET` → `BLOB_STORE_PATH` → refuse to boot in production (unless
`ALLOW_EPHEMERAL_BLOB_STORE=1` is written down), so a migration to object storage later has one
obvious direction.

**The filesystem performs the compare-and-set.** Each version is its own file, `v0000000001.blob`. A
conditional push targets exactly `expectedVersion + 1` and creates it with `link()`, which fails with
`EEXIST` if that version already exists. That single syscall *is* the CAS: atomic on any POSIX
filesystem, valid across processes rather than only within one event loop, and with no lock that can
leak if a process dies holding it.

`link()` rather than an exclusive `open()` because it also gives durability. Bytes go to a temp file
and are fsync'd **first**, and only then linked into place — so a crash mid-write cannot publish a
torn file at a version number readers already consider live. The directory is fsync'd too, or the new
entry can be lost even though the file's contents were durable.

**The newest `BLOB_RETAIN_VERSIONS` versions are retained** (default 5), unlike the in-memory store
which keeps only the latest. That is what makes point-in-time recovery possible ("my session broke,
give me yesterday's cookies") without the unbounded growth of the original "every version is kept"
rule, under which nothing above the store ever pruned. Pruning happens after each write publishes,
never touches the version just written, and is best-effort — a failed delete is reclaimable bytes,
not a failed push. The per-team quota (`BLOB_TEAM_QUOTA_BYTES`) is measured against live bytes before
anything is written; see §9.

Verified against the live API on this server: push → version 1, push → version 2 (both files on
disk), a stale `baseVersion` → `409 stale base version`, pull → the exact bytes back. `blobRef` now
names the store that actually holds them (`file://…`, resolving to a path an operator can `ls`),
because a ref support cannot follow is worse than no ref.

### One defect this introduced, and its fix

Turning on `BLOB_STORE_PATH` made the backend test suite write **8 real files per run into production
blob storage** — the same `.env` leak that once made tests hit the live database, since requiring
`@prisma/client` auto-loads `.env`. Every e2e spec now empties `BLOB_STORE_PATH` and `S3_BUCKET`
alongside `DATABASE_URL`, and the delta is asserted at zero. Back up `/var/lib/lobster/blobs`
alongside the database: losing it loses every snapshot with no local copy left.

## Correction: the key custody design was over-built, and is now simple

The original plan derived the encryption key from the account password and issued a printed recovery
code, so the server could never read profile data. **That was wrong for this product**, and it was my
error rather than a requirement: I put it in the options menu, marked it "Recommended", and the owner
chose from the list I wrote.

Two things settle it:

1. **The reference product does not do this.** Across all the Octo Browser research gathered for the
   concurrency decision, there is not one mention of a recovery code, a master password, a customer
   encryption key, or zero-knowledge storage. Octo users sign in and their profiles are there.
2. **The failure mode was worse than the risk.** Forgetting the password *and* losing the code meant
   permanent loss of every profile, with nothing support could do — for an operator who runs their
   own server and can already read the database.

### What it is now

One route. `GET /vault/key` returns the account's key, generated on first use. Signing in is all a
user needs to reach their profiles from a new machine; a password reset costs them nothing; there is
no setup step and nothing to write down.

The key is still used to derive a **separate key per profile** (HKDF), so one profile's key does not
open another's, and the snapshot bytes on the server are still unreadable without it.

**The tradeoff, stated plainly:** the server can read profile data, because it holds the key. That is
what Octo does, and it is the right posture when the operator owns the server.

Removed: Argon2id key derivation on both sides, the recovery-code alphabet and normalisation, the
double key-wrapping, `enroll`/`rotate`/`recovery-code-used`, and the desktop unlock/lock flow. What
survives is what earns its place — per-profile key derivation, and the cross-language vectors that
pin Rust and TypeScript to identical results.

## Phase 6 as built: one machine at a time

Octo's rule, verbatim from their docs: *"It is not possible to work with the same profile
simultaneously, but you can do so in turns."* We match the block and improve on the recovery.

**Why a hard block at all.** A profile is one browser identity. Running it from two machines means
the same account arriving from two IPs — which is itself the signal an anti-detect profile exists to
avoid. So `acquire` refuses; it does not queue.

**Why a lease rather than a boolean.** A machine that crashes never gets to clear a flag. Octo's
answer is that the profile stays claimed until someone manually "force stops" it — and their own docs
warn that doing so can split-brain, with the other device's work silently not syncing. Ours carries a
**150-second expiry** that the holder refreshes while the browser runs, so a crashed claim lapses on
its own:

| | Octo | Here |
|---|---|---|
| Second opener | Blocked | Blocked |
| Message | "Profile is launched on another device" | "This profile is open on *Ivy's desktop*. Close it there first. If that device is offline, the profile frees itself in about 150s." |
| Crashed machine | Claimed indefinitely; manual force-stop, which may split-brain | Frees itself in ~150s, no operator |

**The database is the arbiter, not application logic.** `profileId` is the primary key of
`profile_leases`, so two racing callers cannot both insert; taking over a lapsed lease is a single
conditional `UPDATE ... WHERE expiresAt <= now`, so the check and the write cannot interleave. A
read-then-write acquire would let two machines both believe they hold the profile — which for this
product is both a corruption hazard and a detection event.

A machine that was taken over while suspended **cannot extend or release** the claim it lost: refresh
and release are scoped to the caller's own `leaseId`. Tested, along with the race and the
self-healing takeover.

Verified live: machine A claims it, machine B is refused with the message above.

**Not yet wired:** the desktop launch path does not call this. Until it does, the block exists on the
server but nothing enforces it at launch.

## Phase 7 as built: first paint stops waiting for the network

**The defect.** `App.tsx` held first paint until `auth_status()` resolved, and that command calls
`/auth/me` with a **15-second timeout**. On a slow or unreachable network a cold start showed an empty
`div` for up to fifteen seconds — while the profile list the user actually wanted was readable from
local SQLite in single-digit milliseconds. The comment explaining the block was sound about *why*
(flashing the sign-in screen at a signed-in user reads as having been logged out); it was the
mechanism that was wrong.

**The fix.** A local identity cache, written only after a successful verification, so it tracks
reality:

```
paint  ──▶ auth_status_cached()   local keychain read, no network, immediate
verify ──▶ auth_status()          /auth/me behind the painted UI
```

Only the verified answer may sign someone **out** — the cached one is a memory, not proof. Sign-out
clears the cache too, or the next cold start would flash a name that is signed out.

| | Before | After |
|---|---|---|
| First paint waits on | `/auth/me` | a keychain read |
| Healthy network | ~21 ms | immediate |
| Slow / unreachable | **up to 15 s of blank screen** | immediate; offline state resolves behind the UI |

**Guarded against regression.** A test reads the body of `auth_status_cached` and fails if it ever
mentions `current_user`, `reqwest`, `await` or `.send(` — because routing it back through the network
puts the 15-second timeout back on the critical path, and that is invisible on a fast connection and
only hurts the users already having a bad time.

**Not addressed here:** the profile list re-polls every 8 seconds and there is no virtualisation, so
this covers the boot path rather than every startup cost named in the original plan.
