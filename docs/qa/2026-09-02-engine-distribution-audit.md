# Engine distribution audit — 2026-09-02

**Scope:** the path from a Chromium `out/` directory to a browser running on a customer's machine:
`lobium/` (series, branding overlay, `stage-branding.mjs`), the two packagers
(`scripts/package-lobium-runtime.{sh,ps1}`), `scripts/verify-lobium-runtime.mjs`,
`ci/validation/engine-archive-gate.mjs`, `scripts/bump-engine-version.mjs`, the two product builds
(`scripts/build-linux-product.sh`, `scripts/build-windows-product.ps1`), `engine-manifest.json`,
`apps/desktop/src-tauri/src/engine_provision.rs` + its callers in `lib.rs`, the installer hooks, the
nginx download location and the web root on `158.220.91.217`. Read-only; nothing was changed
outside this file. Every `file:line` below was re-read today against `main` at `af4db82`.

**Method.** Code reading, plus measurement of the *published* bytes rather than the tree: the four
installers and four engine archives under `/var/www/lobster-downloads/download/`, the served
`engine-manifest.json`, the markers inside both bundled installers, and locale/resource paks
extracted from the published Linux archive. The seven-domain master plan
(`2026-09-02-full-audit-and-master-plan.md`) left this domain "not yet audited"; this closes it.

## Ground truth, measured on the web host today

| artifact | bytes | sha256 | agrees with |
|---|---|---|---|
| `engine/lobium-linux-x64-152.0.7977.42-b2.tar.gz` | 273,071,244 | `d267977f…` | committed manifest, served manifest, both `.deb`s' manifest, `.deb` stamp, `dist-linux/` copy |
| `engine/lobium-win-x64-152.0.7977.42-b2.zip` | 291,049,912 | `1ed28f18…` | committed manifest, served manifest, both `.exe`s' manifest, bundled `.exe` stamp, `release/win-x64/SHA256SUMS` |
| `engine/lobium-linux-x64-152.0.7977.42.tar.gz` (superseded) | 270,690,183 | `bfb43ad4…` | kept for rollback (Chromium-branded build) |
| `engine/lobium-win-x64-152.0.7977.42.zip` (superseded) | 290,775,298 | `adcbb43d…` | kept for rollback |
| bundled `Lobster-Browser-1.0.0-x64-setup.exe` | 241,640,053 | — | embeds marker tree `f2610997…` = the `-b2` zip's tree; stamp `1ed28f18…` |
| bundled `lobster-browser_1.0.0_amd64.deb` | 332,905,288 | — | embeds marker tree `c77e3f1a…` = the `-b2` tarball's tree; stamp `d267977f…` |

So **today, every published file is coherent**: one manifest everywhere, both digests real, both
bundled installers carry the exact trees the manifest names. What follows is about *how little of
that is enforced* — most of it is operator discipline recorded in commit messages (`520d01a`,
`7afec41`), and the one place it was automated on Linux had the inverse bug until `d4a8438`
(20:54 today). Also measured, and the basis of several findings below:

- the published Windows zip carries **220 `.pak.info` files, 74,720,250 bytes** (13% of the
  runtime), 529 of 556 entry names with backslash separators, flat layout, marker
  `packagedAt 2026-08-31T21:43:17Z`, revision `a0c6f9a` (a commit in this repo), clean;
- the published Linux tarball carries `angledata/VkLayer_khronos_validation.json` (127,900 B) and
  `angledata/VkICD_mock_icd.json`, `chrome` at mode `0775`, no `chrome_sandbox`, 366 files, 0
  symlinks, marker revision `f669280` (a commit), clean;
- `locales/de.pak` and `locales/fr.pak` in that tarball contain **"About Lobium", "Relaunch Lobium"
  ×5, "Lobium is made possible…" in English** and 0 × "Über Lobium"; 581 × "Lobium" in de, fr
  and en-US alike; 0 × "Chromium" in any pak;
- `~/lobium-build/src/chrome/app/resources/chromium_strings_de.xtb` still holds 535 "Chromium"
  translations (81 locale files), untouched by the stager.

## Findings

Severity: **critical** = arbitrary code on every install or a release that cannot work; **high** =
a real user-visible failure or a silent population split that nothing prevents; **medium** = a
defect with a bounded blast radius or a missing control; **low** = hygiene, drift, or a hardening
nit.

### C1 — critical — The refreshed manifest is unsigned remote code, and the module says otherwise

**Evidence.** `engine_provision.rs:5` promises "verifies its SHA-256 against a *signed* manifest".
`refresh_manifest_cache` (`:88-115`) fetches
`https://lobrowser.com/download/engine/engine-manifest.json` (`:67-72`), parses it for this
platform (`:105`) and writes it to app data; `engine_manifest_path` (`lib.rs:531-539`) then prefers
that cached copy over the one shipped in the installer for every later read. `parse_manifest`
(`:156-171`) accepts *any* `url` string — no scheme check, no host pin — and any 64-hex digest. No
signature, no key, no sequence number. The archive digest that "gates the bytes" (`:348-356`) is
whatever that JSON says. `LOBSTER_ENGINE_URL/SHA256` (`:39-55`) are honoured in release builds.

**Failure scenario.** Whoever can write one 1.6 KB file under `/var/www/lobster-downloads/` — the
single VPS, the optional token upload drop (`deploy/nginx/lobster-site.conf:132-139`, whose
snippet lives outside the repo), a compromised deploy account, or anyone who can answer for
`lobrowser.com` with a certificate the launcher trusts — installs an arbitrary `chrome` on every
client at its next launch, with the user's full privileges, silently ("Silent by design",
`lib.rs:2139`). The present control is exactly one thing: TLS with `webpki-roots`
(`Cargo.toml:87`, `rustls-tls`). That is a good control against MITM and a non-control against a
web-root compromise, which is the more likely event on a one-box deployment.

**Fix.** (1) Sign the manifest: publish `engine-manifest.json.sig` (minisign/ed25519; the nginx
regex at `lobster-site.conf:79` already admits `.sig`), compile the public key into the launcher,
verify before `parse_manifest` and never cache an unsigned or badly-signed document. (2) Pin the
origin: refuse any `url` that is not `https://lobrowser.com/download/engine/…` unless a build-time
`LOBSTER_SELF_HOSTED` feature is on. (3) Add `sequence` (monotonic) and `publishedAt`; keep the
newest of bundled / cached / fetched (see M6). (4) Put `treeSha256` per platform into the manifest
so the archive digest AND the extracted tree are both pinned (see M2). (5) Fix the module comment.

### H1 — high — Every fresh web install downloads the engine twice, into the same file, with no lock

**Evidence.** The background updater (`lib.rs:2141-2163`) is spawned unconditionally in `setup`:
on a web install with no engine, `engine_matches_source` is false (`:2151`),
`bundled_engine_satisfies` is false (`:2154`, no `resources/lobium`), so it calls
`engine_provision::provision` (`:2158`). Meanwhile `EngineGate` mounts and calls `engine_status`
then `provision_engine` (`EngineGate.tsx:63-68`, auto-started at `:88`), which calls the same
`provision` (`lib.rs:657`). Both write `parent/.lobium-engine.download` (`engine_provision.rs:260`)
and extract into `parent/.lobium-engine.incoming` (`:359`). There is no mutex, atomic, or
in-flight flag anywhere (`grep` of `lib.rs`/`engine_provision.rs`: only `LOBIUM_BIN_IS_MANAGED`).
The gate's own comment (`EngineGate.tsx:39-41`) says two stacked downloads "fails, and would look
exactly like the bug being fixed" — it guards the button, not the updater.

**Failure scenario.** Guaranteed: 2 × ~275 MB per first run on the slow, un-CDN'd origin the
product already apologises for. Timing-dependent, from the code paths: on Linux the second caller's
`remove_file` (`:271`) unlinks the first's open file, or `File::create` (`:310`) truncates it under
the first writer — both hashers pass (they hash their own stream, `:327`) and the interleaved file
fails in `unpack_tar_gz` ("extracting engine archive"), so the gate shows an error and *Retry*
(a third download) succeeds. On Windows, `remove_file` on the other task's open handle leaves the
name delete-pending, so `File::create` fails with "creating temp engine archive: Access is denied"
and every *Retry* fails the same way until the invisible background download completes minutes
later — which reads exactly like the field report the gate was rewritten to fix
(`EngineGate.tsx:29-34`). Confirm the Windows symptom on the box; the double download and the
shared path are certain from the code.

**Fix.** One provisioning job per process: a `tokio::sync::Mutex<Option<JoinHandle>>` (or
`OnceCell` + broadcast of progress) in `AppState`; `provision_engine` and the updater both *join*
the running job instead of starting another. The updater must not run at all when no engine is
present — first run belongs to the gate. Give the temp files per-attempt unique names and hold an
advisory lock file in `parent` so a second process (the single-instance plugin covers the app, not
a developer's `LOBSTER_*` test run) cannot collide either.

### H2 — high — The updater swaps the directory running profiles execute from

**Evidence.** `lib.rs:2133-2137`: "Deliberately not applied mid-session: swapping the engine under
running profiles would kill live browsers." The code below it does exactly that for every web
install that already has a managed engine: `provision` → `extract_and_swap`
(`engine_provision.rs:488-529`) renames the live `~/.local/share/lobster/lobium` to `lobium.old`
(`:512`), renames the new tree in (`:514`) and deletes the old one (`:516`) — while
`LOBSTER_LOBIUM_BIN` points into it and profiles may be running from it. Only *bundled* installs
are safe, because their engine lives under `<resources>/lobium`.

**Failure scenario.** Linux: the browser keeps its mmapped `chrome`/`.so`/`.pak`, but everything
opened lazily is gone — the font pack (`FONTCONFIG_FILE` → `<runtime>/fonts`, opened per face on
demand: text turns to tofu mid-session), `WidevineCdm/`, `libvk_swiftshader.so` on a late GPU
process restart, `chrome_crashpad_handler` on a crash. Windows: the rename at `:512` is expected to
fail with a sharing violation while `chrome.exe`/`chrome.dll` are mapped, so the update fails on
every launch that has a profile open (retried cheaply — the archive is kept, `:375-379`) and the
error is only a `tracing::warn` (`lib.rs:2160`); confirm on the box. Either way, after a successful
in-session swap the *next* profile launched in the same session already runs the new engine
(`LOBSTER_LOBIUM_BIN` is the same path) — not "the next launch" the comment promises.

**Fix.** Versioned runtime directories: install into `lobium/<version>-<sha256[..8]>/`, write a
`current` pointer (file or symlink) only at *startup* and only when the sidecar reports no running
profile; never rename or delete a directory a live process was launched from (the sidecar knows the
pids per runtime); garbage-collect non-current versions at the next startup. This also makes
rollback a pointer flip.

### H3 — high — The Linux publish path has two mechanisms, and only one is gated

**Evidence.** `build-linux-product.sh:56` names the archive
`lobium-linux-x64-${ENGINE_VERSION}.tar.gz` (no `-bN`), while the manifest URL is
`…-b2.tar.gz`. With `LOBSTER_RESTAMP_ENGINE=1` (`:181-191`) the script writes the fresh digest
straight into the manifest and prints "PUBLISH … at `$MANIFEST_URL`" — the *same* `-b2` URL —
without running `engine-archive-gate.mjs`. The gate runs only inside
`bump-engine-version.mjs --archive` (`:307-332`, with the platform cross-check `:342-357` and the
`stale` clearing `:371-374`), a path the RESTAMP branch bypasses entirely. And `deriveArtifactUrl`
(`bump-engine-version.mjs:231-236`) explicitly *permits* republishing a new digest at an unchanged
URL for an unchanged version — the same-name republish window that `520d01a`/`7afec41` had to avoid
by hand and that the RESTAMP comment (`build-linux-product.sh:171-173`) warns about.

**Failure scenario.** Operator follows the script's instruction: uploads the new bytes over
`…-b2.tar.gz`. Every installed client whose cached/bundled manifest still names the old digest
downloads the new file and fails its hash check — the "retries forever" incident, third time.
Or: the RESTAMP archive is never gated, so a runtime whose capability probe failed
(`package-lobium-runtime.sh:159` tolerates that with `|| echo '{}'`) is published with an empty
capability list that the gate would have refused (`engine-archive-gate.mjs:441-455`).

**Fix.** Delete the manifest write from the build script; keep only the *refusal* (`:203-214`).
The one publish command is `bump-engine-version.mjs --archive`, which must (a) refuse a changed
digest at an unchanged URL and derive `-b<N+1>` automatically (`--url` to override), (b) run the
gate with `--check-manifest` on the archive the build will bundle, and (c) be what
`build-linux-product.sh` calls in the "new tree" case instead of restamping.

### H4 — high — The Windows bundled installer stamps the manifest digest onto an unverified runtime

**Evidence.** `build-windows-product.ps1:195-245`: `-EngineRuntime <dir>` is verified only for
*self*-consistency (`verify-lobium-runtime.mjs`, `:210`), copied (`:216`), then stamped with the
manifest's `win-x64.sha256` (`:230-241`). Nothing compares the runtime's `artifacts.treeSha256` with
the marker inside the zip the manifest actually publishes. The parameter comment (`:51-52`) says
"Its ZIP must be the one the manifest's win-x64 entry names" — a rule, not a check. This is the
exact shape of the Linux bug fixed in `d4a8438`, on the platform that ships first. Today it happens
to hold (installer marker tree `f2610997…` = zip tree; stamp `1ed28f18…`), because the operator
rebuilt from the same `dist-win/lobium-runtime-…` directory.

**Failure scenario.** A rebuilt runtime (new patch, same version) is bundled while the manifest
still names the previous zip. Bundled installs run engine X stamped as Y; the updater never
replaces it (`engine_matches_source` is true); web installs download Y. Two populations with
different fingerprint code under one version string, and a bug "fixed" in the engine that persists
for every bundled user until the next installer.

**Fix.** Do what `d4a8438` does on Linux: require the published zip on hand under
`dist-win/<basename of manifest url>`, check its digest equals the manifest, extract its marker and
require `treeSha256` equality with the runtime being embedded; refuse otherwise. Better still,
build the bundled installer *from the published zip* (extract it into `resources/lobium`), so the
embedded bytes are the published bytes by construction and the check disappears.

### H5 — high — Nothing verifies the extracted tree; a quarantined DLL is a permanently "healthy" engine

**Evidence.** After extraction the client checks only that `chrome[.exe]` exists and the stamp
matches (`engine_provision.rs:381-386`, `:238-242`); `LOBSTER_ENGINE.json` is never read by the
launcher for verification (only for the sandbox/GPU heuristics, `lib.rs:1367,1378`) nor by the
sidecar (`managed-engine.ts:78-100` compares the stamp bytes only). The whole attestation
machinery — the ledger, the tree hash, the gate — stops at the publisher's desk. Answer to the
brief's question: **the launcher verifies the archive digest only, never the tree, never after
extraction.**

**Failure scenario.** Defender or a third-party AV quarantines `chrome_elf.dll` or
`vk_swiftshader.dll` from the freshly extracted, unsigned Chromium fork (S1), or an operator deletes
a file by hand: the stamp still says "exactly the manifest's engine", every launch fails with an
opaque sidecar error, nothing self-heals, and *Retry* on the gate says "present". The same
mechanism hides a partial extraction that tar/zip did not report.

**Fix.** Before the swap, recompute the ledger of the staging tree with the gate's algorithm
(`path\tbytes\tsha256\n`, `verify-lobium-runtime.mjs:566-592`) and require equality with the
marker's `treeSha256` *and* with a `treeSha256` carried in the manifest entry (C1.4). On a launch
failure, run the same check and offer "Repair engine" (re-extract from the kept archive).

### M1 — medium — Branding: every non-English locale shows English wherever the product is named

**Evidence.** `stage-branding.mjs:133-204` rewrites the English sources (`.grd/.grdp`) only. GRIT
keys `.xtb` translations by the fingerprint of the *source text* and `chromium_strings.grd` sets
`fallback_to_english="true"`, so every rewritten message loses its translation and ships in
English. Measured in the published tarball: `de.pak`/`fr.pak` contain "About Lobium", "Relaunch
Lobium", "Lobium is your default browser" in English, 0 × "Über Lobium"; 581 × "Lobium" in de, fr
and en-US alike. The 14 `CHROMIUM_ONLY_FILES` (`:162-179`) have the same effect through
`components_strings_*.xtb` (40 "Chromium" translations in `_de`).

**Failure scenario.** A `de-DE` persona opens Settings → "About Lobium" in English inside a German
page; SSL interstitials ("Lobium cannot verify…"), password bubbles ("Relaunch Lobium"), default-
browser prompts all switch language mid-screen. Not web-observable, but a visible tell for the
operator's customers, and the exact class the overlay was built to remove. If a future edit keeps
a source id unchanged, the German "Chromium" translation leaks instead.

**Fix.** Extend the stager to `.xtb`: for each transformed message compute the old and new ids
with grit's own `tclib.Message.GetId()` (`tools/grit/grit/extern/FP.py`), rewrite
`<translation id>` and apply the same `Chromium→Lobium` transform to the translation text, for
`chrome/app/resources/{chromium,settings_chromium,google_chrome}_strings_*.xtb`,
`components/strings/components_{chromium_,}strings_*.xtb`, `extensions/strings/*.xtb`. Add a
release gate: for every `locales/*.pak`, 0 × "Chromium" AND 0 × "About Lobium" outside `en-*`.

### M2 — medium — Reproducibility is one-sided: Windows cannot reproduce, Linux cannot prove which epoch

**Evidence.** Linux: reproducible tar (`build-linux-product.sh:151-152`) and
`SOURCE_DATE_EPOCH` for the marker (`package-lobium-runtime.sh:199-206`) — but the release commit
`7afec41` records no epoch, and OPERATIONS.md:165 "the publish log records the value used" names
a log that does not exist (it is recoverable only from the marker inside the archive:
`2026-09-01T19:48:53Z` = `1788292133`). Windows: `packagedAt = (Get-Date)`
(`package-lobium-runtime.ps1:667`), `Compress-Archive` embeds mtimes and writes backslash entry
names (529/556 in the published zip); the zip is unreproducible by construction, which is why H4
can only be closed by tree comparison. Dirty-tree definitions differ (sh `:161` counts untracked
files; ps1 `:472` `--untracked-files=no`), so the same working tree can be "dirty" on one host and
"clean" on the other, and the gate fails on dirty (`engine-archive-gate.mjs:435-437`).

**Fix.** Honour `SOURCE_DATE_EPOCH` in the ps1 marker; write a deterministic zip from Node
(`yazl`/`archiver` with fixed timestamps and `/` separators — the gate and the Rust `zip` crate both
accept it) instead of `Compress-Archive`; record epoch, revision, digest and tree per artifact in
`release/PUBLISH-<date>.json` from the publish script (M5); align the dirty definition
(untracked-excluded on both, since `.rej`/`.orig` litter is normal on the Windows host).

### M3 — medium — No disk-space preflight and no resume

**Evidence.** `provision` streams to a temp file (`engine_provision.rs:309-332`); any error or a
60 s stall deletes the partial file (`:338-346`) and the next attempt starts from byte 0. No free-
space check precedes a ~275 MB download plus ~600-840 MB extraction plus, on update, the old
runtime kept until the swap (`:509-516`): peak ≈ 2.3 GB, surfaced as a raw `io::Error` from tar.
nginx serves ranges (`lobster-site.conf:113-114`), unused.

**Fix.** Check free space on `parent` (`fs4::available_space`) against `Content-Length` × ~4 before
the request and say so in the gate; on failure keep the partial and resume with
`Range: bytes=<len>-`, re-hashing the prefix from disk; retry a stalled stream 3× in-process
before surfacing.

### M4 — medium — The Linux marker's version is copied from the manifest, not observed from the binary

**Evidence.** `package-lobium-runtime.sh:162` reads `CHROMIUM_REF` from
`engine-manifest.json` and writes it as the marker's `version`/`provenance.chromiumRef`;
`build-linux-product.sh:55-56` names the archive from the same field. Windows reads the PE
`ProductVersion`, the checkout's exact tag and `build.ps1`'s pin and requires all three to agree
(`package-lobium-runtime.ps1:432-459`). The gate's `--check-manifest` version test
(`engine-archive-gate.mjs:465-467`) is therefore circular on Linux.

**Failure scenario.** The pending `.42 → .64` rebase (Wave 4): the manifest carries
`rebuildPending` at `.42`, the new binary is `.64`, and the Linux packager attests and names it
`.42`. `getHighEntropyValues(['fullVersionList'])` reports `.64` while every pin and the archive
name say `.42`.

**Fix.** `"$OUT/chrome" --version` (the POSIX early-exit is fine on Linux) → require equality with
`build.sh`'s `CHROMIUM_REF` and the checkout's exact tag; record `chromiumCommit` and
`buildArgsSha256` like Windows does (L2).

### M5 — medium — Publishing is a hand procedure with no script, no sums, no signatures

**Evidence.** No script in the repo writes to `/var/www/lobster-downloads/download/` (grep); the
release commits describe `scp`, a manual download-and-hash, and a manual manifest flip. Installers
are renamed by hand from Tauri's `Lobster Browser_1.0.0_x64-setup.exe` to the catalog's
`Lobster-Browser-1.0.0-x64-setup.exe` (`downloads.catalog.ts:48-51`). The nginx location admits
`.sha256` and `.sig` (`lobster-site.conf:79`) but nothing produces them; the download page shows no
digest; catalog sizes are hand-typed (`:99-129`: web installer "29.3 MB" vs 30,885,540 bytes
served). `--check-url` compares `Content-Length` only (`engine-archive-gate.mjs:498-507`).

**Fix.** `scripts/publish-release.sh`: gate → upload archive under a new `-bN` name → GET the URL
and hash it → write `SHA256SUMS` + minisign signature beside it → flip the manifest with
tmp+`mv` → GET the manifest and diff against the committed one → append
`release/PUBLISH-<date>.json`. Derive catalog sizes from the files at web build time; print the
digests on the page. Make `--check-url` hash the body behind an explicit `--fetch`.

### M6 — medium — The cached manifest wins on precedence, not on recency

**Evidence.** `engine_manifest_path` (`lib.rs:531-539`) returns the cached remote copy whenever it
exists; `refresh_manifest_cache` overwrites it with whatever parses (`engine_provision.rs:105-113`).
No sequence, no date, no comparison with the bundled copy. `ensure_lobium_env` then prefers a
managed engine that matches *that* manifest over the bundled one (`lib.rs:1439-1446`).

**Failure scenario.** A new installer ships (bundled engine Y, manifest Y) before the served
manifest is updated (still X), or the served manifest is rolled back: every fresh bundled install
caches X, the updater downloads the older engine X, and the next launch prefers it over the newer
bundled Y. Downgrade by ordering, silent.

**Fix.** `sequence` in the manifest (C1.3); the reader keeps the highest of bundled/cached/fetched
and logs which one won; the updater only moves *forward*.

### M7 — medium — TLS root policy is an undocumented product decision with a security dependency

**Evidence.** `Cargo.toml:87`: `rustls-tls` = Mozilla roots only. Under corporate TLS interception
(the environment the `system-proxy` fix in `5724cda` was for), every launcher request — manifest,
engine, API — fails with a certificate error while the user's browser works: the same silent shape
as the second-PC failure. Switching to native roots without C1 would turn that interception into
an engine-injection path.

**Fix.** Decide explicitly, in this order: sign the manifest and pin the origin (C1), then consider
`rustls-tls-native-roots` for reachability, and surface certificate errors in the gate with the
words "a proxy is intercepting TLS".

### M8 — medium — Upgrade and uninstall cleanup: too much on Linux, too little on both

**Evidence.** `deb-postrm.sh:38` runs the engine-cache purge for `remove|upgrade|deconfigure`, so
every `.deb` upgrade deletes every user's `~/.local/share/lobster/lobium` — a web install re-
downloads ~275 MB after each app upgrade, and a bundled install loses any newer engine the updater
staged. Neither `hooks.nsh:112-113` nor the postrm removes the sibling leftovers
`.lobium-engine.download`, `.lobium-engine.incoming`, `lobium.old`, so up to ~1.1 GB can be
orphaned and the non-recursive `RMDir "$LOCALAPPDATA\lobster"` silently fails.

**Fix.** `upgrade` keeps the cache (the stamp re-validates it on the next launch); both uninstall
paths remove the three sibling names; the provisioner uses one `lobium-work/` directory for all its
temporaries so cleanup is one `rm -rf`.

### M9 — medium — The Windows engine ships 74.7 MB of GRIT build metadata the Linux packager deletes

**Evidence.** `package-lobium-runtime.sh:97-103` deletes `locales/*.pak.info` ("dead weight, a
fingerprintable artifact, and an information leak about the build machine");
`package-lobium-runtime.ps1:566-572` copies `locales` wholesale. Published `-b2` zip: 220
`.pak.info` entries, 74,720,250 bytes; contents are resource-id tables naming source files such as
`../../chrome/app\settings_chromium_strings.grdp`.

**Fix.** Delete `*.pak.info` in the ps1 packager and add a shared deny-list assertion to
`engine-archive-gate.mjs` for both platforms: `*.pak.info`, `*.TOC`, `VkLayer_*`,
`VkICD_mock_icd*`, `*.pdb`, `*.runtime_deps`.

### S1 — high — Nothing is code-signed, and what that costs on Windows

**Evidence.** `tauri.windows.conf.json` has no `certificateThumbprint`/`signCommand`;
`verify-installer.ps1:76-84` reports UNSIGNED as a warning; `installer/README.md` documents the gap
("Not solved here: code signing"). The engine's `chrome.exe`/`chrome.dll`/`chrome_elf.dll` are
unsigned Chromium builds; the `.deb` is unsigned; no `SHA256SUMS`/`.sig` on the web root (M5).

**What an unsigned installer means.** The installer arrives through a browser, so it carries
Mark-of-the-Web and SmartScreen shows "Windows protected your PC / Unknown publisher" to every
first-time user; reputation is per file hash, so every rebuild resets it to zero. The engine
archive is fetched by the app (no MotW), so SmartScreen does not gate `chrome.exe` — but Defender
real-time protection and third-party AVs weigh unsigned Chromium-derived binaries with hooking
patterns (`chrome_elf.dll`, renderer injection) heavily, which combined with H5 produces launch
failures nobody can diagnose. On Linux the gap is integrity, not reputation: nothing lets a user
or a mirror verify a `.deb`.

**Fix.** Procurement first, code second: Azure Trusted Signing (cheapest; immediate SmartScreen
standing; needs a verifiable organisation record) or an EV certificate (immediate standing) — an OV
certificate signs but earns reputation slowly. Wire it through `bundle.windows.signCommand` so
`tauri build` signs `lobster-desktop.exe`, the installer and the uninstaller. Sign the engine's
PE files on the Windows build host **before** `package-lobium-runtime.ps1` runs, so the ledger
covers the signed bytes (signing after packaging would invalidate the attestation). Linux: publish
`SHA256SUMS` + a minisign signature; an apt repository with a signing key can follow.

### Low findings

- **L1 — Linux ships the Vulkan debug manifests it removes the libraries for.**
  `package-lobium-runtime.sh:56-63` excludes `libVkLayer_khronos_validation.so`/`libVkICD_mock_icd.so`,
  but `:89-95` copies `angledata/` wholesale, so `VkLayer_khronos_validation.json` (127,900 B) and
  `VkICD_mock_icd.json` ship with `library_path` pointing at files that do not exist. The ps1 strips
  them (`:592-597`). Same fix as M9.
- **L2 — Two marker schemas under one `schemaVersion: 2`.** Linux lacks `artifacts.algorithm`,
  `provenance.chromiumCommit`, `buildArgsSha256`, `fontInventory`;
  `verify-lobium-runtime.mjs:607-609` refuses any platform but `win-x64`, so the Linux packager
  never independently verifies what it wrote. One schema, one verifier, run by both packagers.
- **L3 — Docs and comments that describe a different system.** OPERATIONS.md:69-70 and :319-332
  publish to a GitHub release URL; `bump-engine-version.mjs:412-420` says
  `package-lobium-runtime.sh` produces the tarball (`build-linux-product.sh` does);
  OPERATIONS.md:165 names a publish log that does not exist; `hooks.md:325` says Widevine is off
  while both GN files set `enable_widevine = true`; `engine_provision.rs:5` "signed";
  `lib.rs:2136` "never mid-session".
- **L4 — Modes are preserved, including the build user's.** `set_preserve_permissions(true)`
  (`engine_provision.rs:427`) plus `cp -a` from `out/` ships `chrome` as `0775` (group-writable);
  a setuid bit on the build host would travel too. Normalise in the packager (`chmod -R go-w`,
  clear `s` bits) and assert modes in the gate.
- **L5 — Reuse-then-extract by path.** The leftover archive is hashed by path (`:266-269`) and
  reopened by path for extraction (`:424-433`); a same-user swap between the two installs
  unverified bytes. Hash and extract from one opened handle (seek to 0).
- **L6 — The web catalog hard-codes `ENGINE_VERSION`** (`downloads.catalog.ts:35`), a fifth copy of
  the pin outside the coherence test's four.
- **L7 — Windows zip entry names use backslashes** (529/556). The Rust `zip` crate treats `\` as a
  separator only on Windows and the gate normalises, so it works — until an archive is ever
  extracted on Linux (CI, a mirror check). A Node-written zip (M2) fixes it for free.

## The eight questions the brief asked, answered

1. **Digest/version coherence (manifest, stamps, published files, both platforms).** Coherent today
   on every axis measured (table above). Enforced on Linux since `d4a8438` (tree comparison against
   the published archive), enforced nowhere on Windows (H4), and the Linux *publish* path still has
   an ungated branch that pairs a new digest with the old URL (H3). The Linux marker's version is a
   copy of the manifest's, not a measurement (M4).
2. **Reproducibility and provenance.** Linux archive reproducible given the epoch, which is recorded
   only inside the archive; Windows unreproducible by construction; dirty semantics differ (M2).
   Both published markers name real, clean commits (`f669280`, `a0c6f9a`).
3. **TOCTOU / partial download / extraction safety.** Zip-slip is handled by the crates in use
   (`tar 0.4.46` `validate_inside_dst`; `zip 7.2.0` `enclosed_name` + symlink containment) and the
   form is read from magic bytes; the digest is checked before anything touches the install path;
   the swap has a rollback. What is missing: a lock (H1), resume and a disk-space check (M3), a
   post-extraction tree check (H5), one-handle reuse (L5), mode normalisation (L4), and the swap
   itself is unsafe under a running browser (H2).
4. **Update path when a new engine is published while installs run the old one.** The manifest
   refresh reaches installed clients on their next launch (good), the updater then downloads in the
   background (good) and swaps the live directory (H2) with no monotonicity (M6), and on a fresh web
   install collides with first-run provisioning (H1). Bundled installs are safe because the bundled
   copy is never touched, and prefer a newer managed engine correctly.
5. **Attestation marker verification on the client.** Archive digest only. The tree hash, the
   per-file ledger and the capability list inside `LOBSTER_ENGINE.json` are never read by the
   launcher or the sidecar for verification (H5).
6. **Code signing.** Nothing signed anywhere; consequences and the cheapest way out in S1.
7. **Branding leaks.** The overlay and the string pass are complete for English (0 × "Chromium" in
   every pak, PE VERSIONINFO and `--version` say Lobium, icons replaced). The gap is translations:
   every non-English locale shows English for product-name strings (M1). On-disk artefacts that
   real Chrome does not ship: `.pak.info` on Windows (M9), Vulkan debug manifests on Linux (L1).
   "Google" strings are deliberately kept where they name Google's own services — correct for an
   anti-detect engine.
8. **Windows vs Linux packaging.**

| concern | `package-lobium-runtime.sh` (Linux) | `package-lobium-runtime.ps1` (Windows) |
|---|---|---|
| version source | manifest field (`:162`) | PE `ProductVersion` + checkout tag + `build.ps1` pin, all equal (`:432-459`) |
| capability contract | recorded, failure tolerated (`:159`) | 21 hooks required exactly, before and after copy (`:267-315`, `:694-695`) |
| output transaction | `rm -rf OUT` then copy (`:33`) | staging dir, swap, rollback (`:492-499`, `:706-730`) |
| independent verification | none (verifier is Windows-only) | `verify-lobium-runtime.mjs` on the staged tree (`:699-704`) |
| marker fields | no `algorithm`, `chromiumCommit`, `buildArgsSha256`, `fontInventory` | all present (`:653-680`) |
| `packagedAt` | `SOURCE_DATE_EPOCH` honoured (`:199-206`) | wall clock (`:667`) |
| dirty definition | untracked files count (`:161`) | untracked excluded (`:472`) |
| font pack | provisioned inline from the build host's fonts (`:70`) | explicit, scanner-attested pack (`:392-408`, `:618-631`) |
| debug junk | strips `.pak.info` (`:97-103`), Vulkan `.so`s (`:56-63`); ships Vulkan `.json`s | ships 220 `.pak.info`; strips Vulkan `.json`s (`:592-597`) |
| symbols | strips ELF symtab, keeps `.debug` aside (`:120-137`) | n/a (PDBs never in `out/` copy) |
| archive | reproducible tar in `build-linux-product.sh:151-152` | manual `Compress-Archive`, non-reproducible, backslash names, flat |
| archive gate | via `bump-engine-version.mjs` only; RESTAMP path bypasses it | via `bump-engine-version.mjs`, run by hand from the Linux side |
| bundled-installer check | tree compared with the published archive (`d4a8438`) | none (H4) |

## Verified sound (so nobody re-audits them)

Form detection by magic bytes; digest-before-install and fail-closed on mismatch; extraction in a
sibling staging dir with rollback on a failed rename; zip-slip and symlink containment in the
vendored crates; reproducible Linux tar; manifest refresh validated for this platform before it is
cached and written via temp+rename; `platforms` map keyed by compile target; the served manifest,
the committed manifest and the manifest inside all four published installers are identical; both
bundled installers embed exactly the published trees; superseded archives retained for rollback;
nginx `must-revalidate` on archives and manifest, ranges on, 404 not masked; the archive gate's
negative tests; the bump tool's platform cross-check and URL-derivation refusal; the single-instance
plugin; the NSIS pre-install removal of an orphaned `$INSTDIR\lobium`.

## Prioritised plan

**P0 — before the next installer is published (days).**
1. H1: one provisioning job per process; the updater never runs when no engine is present.
2. H3: remove the manifest write from `build-linux-product.sh`; `bump-engine-version.mjs` refuses a
   changed digest at an unchanged URL and derives `-b<N+1>`; the build script calls the gate.
3. H4: `build-windows-product.ps1 -Bundled` compares the runtime's tree with the published zip's
   marker (or extracts the published zip), refuses otherwise.
4. C1 phase 1 (cheap): pin the manifest `url` origin to `https://lobrowser.com/download/engine/`,
   reject `http:`, add `sequence`, fix the "signed" comment.
5. M9/L1: shared deny-list in both packagers and in the gate; re-package Windows without
   `.pak.info` at the next engine publish (a new `-b3`, since the tree changes).

**P1 — the next engine publish (the `.64` rebase is the natural moment).**
6. C1 phase 2: minisign-signed manifest, key in the launcher, `.sig` on the web root.
7. H5 + C1.4: `treeSha256` per platform in the manifest; client verifies the extracted tree before
   the swap and on launch failure; "Repair engine" in the gate.
8. H2: versioned runtime directories with a `current` pointer switched only at startup with no
   profile running; GC at startup.
9. M4: Linux version observed from `chrome --version`; L2: one marker schema and one verifier for
   both packagers.
10. M1: `.xtb` re-keying in `stage-branding.mjs` plus a locale-pak gate.
11. M5: `scripts/publish-release.sh` with `SHA256SUMS`, signatures, served-digest verification and
    a publish record; catalog sizes derived, digests shown.

**P2 — hardening.**
12. M3 (resume, disk-space preflight), M6 (monotonic manifest), M8 (upgrade keeps the cache;
    uninstall removes the temporaries), M7 (documented TLS decision, after C1).
13. S1: start the signing procurement now (it is a purchase, not code); wire `signCommand` and
    sign engine PE files pre-packaging when the certificate exists.
14. L3–L7 as they are touched.

**Needs a real machine to confirm** (the code paths are certain; the exact symptom is not): the
Windows delete-pending behaviour in H1 and the directory-rename failure under a running browser in
H2. Both are one clean web install with a second profile open on the Windows box.
