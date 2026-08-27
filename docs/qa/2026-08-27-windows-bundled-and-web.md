# Windows: two installers — bundled and web

**For the agent on the Windows build host.** No memory of the conversation that produced this is
assumed. `git pull` first; the Linux side has landed the changes this depends on.

## Why

The engine download is slow for real users. It comes from one origin in Portsmouth with no CDN, and
throughput depends heavily on the route: measured from that box on the same day, 78 MB/s to a
well-peered network and 5.6 MB/s to an ordinary one — a 14x spread. A 259 MB engine over the slow
path is minutes.

So the product now ships **both** builds, and the download page offers both:

| | contains | first run |
|---|---|---|
| **bundled** (default) | app + engine | opens immediately, no download |
| **web** | app only | fetches the engine on first launch |

The total bytes are identical. Bundling does not make them arrive faster — it moves WHEN they
arrive, out of the app's single-stream fetch and into the browser's own resumable download. That is
the honest framing; do not describe bundled as "smaller" or "faster to download" anywhere.

## What changed on the Linux side that you inherit

* `tauri.windows.conf.json` no longer declares `resources/lobium`. A new
  `tauri.bundled.conf.json` overlay declares it, and is passed with `--config` for the bundled build
  only. Same tree, same binary, one flag apart.
* `ensure_lobium_env` now prefers a MANAGED runtime **only when it satisfies the current manifest**,
  and otherwise uses the bundled copy. This ordering is the whole reason bundling no longer means
  "the engine can never be updated" — previously the bundled copy was taken unconditionally and a
  newer provisioned engine sat on disk unused.
* A background updater runs after the window is up: if the manifest names an engine that is not in
  use, it downloads it for the NEXT launch. Never mid-session — swapping the engine under running
  profiles would kill live browsers.
* The packager writes `.lobium-engine-version` beside the BUNDLED engine, in the same format
  provisioning writes beside a downloaded one. Without it the updater re-downloads on every launch
  of a fresh install, because the managed directory is empty even though the bundled copy is exactly
  what the manifest names. **If you bundle without writing this stamp, every user re-downloads the
  engine forever.**

## Task

1. `git pull`. Confirm `apps/desktop/src-tauri/tauri.bundled.conf.json` exists and that
   `tauri.windows.conf.json` has NO `resources` key.

2. Stage the engine into `apps/desktop/src-tauri/resources/lobium` as before, then write the stamp
   beside it:

   ```
   version=<engine version>
   sha256=<sha256 of the engine ZIP you publish>
   ```

   It must be the digest of the ARCHIVE, not of any file inside it, and must equal the `win-x64`
   `sha256` in `resources/engine-manifest.json`. Get this wrong and the updater loops.

   **This is not hypothetical — the Linux side hit it on the first attempt.** Re-creating the archive
   from byte-identical content produced a DIFFERENT digest, because `tar`/`gzip` embed mtimes, uid/gid
   and a gzip timestamp. The stamp then named an archive the manifest did not, and a bundled install
   would have re-downloaded the engine on every launch. `Compress-Archive` and most ZIP writers embed
   timestamps the same way, so assume your archive is NOT reproducible unless you have made it so.

   Two defences, and take both:

   * Make the archive reproducible if you can (deterministic entry order, pinned timestamps). The
     Linux build now does: `tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner | gzip -n`,
     verified by building it twice and comparing digests.
   * Never type the digest in two places. The Linux build computes it once and writes it to BOTH the
     stamp and the manifest, so they cannot diverge. Do the same rather than copying it by hand.

3. Build **both**:

   ```
   # web installer — no engine
   npm run tauri -- build --bundles nsis
   # bundled installer — engine inside
   npm run tauri -- build --bundles nsis --config src-tauri/tauri.bundled.conf.json
   ```

   Name them exactly, because the download page derives these and a mismatch serves a 404 from a
   well-formed URL:

   ```
   Lobster-Browser-1.0.0-x64-setup.exe          <- bundled
   Lobster-Browser-1.0.0-x64-web-setup.exe      <- web
   ```

4. Verify, and do it on the built artifacts rather than the tree:

   * the **web** installer contains NO `lobium/` payload, and its `engine-manifest.json` pins the
     published `win-x64` digest
   * the **bundled** installer DOES contain `lobium/chrome.exe` AND `lobium/.lobium-engine-version`,
     and that stamp's sha256 equals the manifest's `win-x64` sha256
   * both report the same app version

5. Test both on a clean machine, with `%LOCALAPPDATA%\lobster` and `%APPDATA%\com.lobster.browser`
   removed and no `LOBSTER_*` env set:

   * **bundled**: first launch opens with NO engine download and NO progress bar. If a download
     starts, the stamp is wrong — that is the failure mode to hunt, not to work around.
   * **web**: first launch downloads from lobrowser.com, hash check passes, app opens.
   * launch an Android profile on the bundled build — it exercises the device-frame capability gate.

6. Push both through LFS in `release/win-x64/` with a `SHA256SUMS`, and report both digests. The
   Linux side verifies the received bytes, publishes, and updates the catalog sizes.

## Report

Per step: what you did, what you measured, what surprised you, what you are unsure of. If anything
here is wrong, say so with evidence — it was written from the Linux side, and you have corrected
that side more than once already.
