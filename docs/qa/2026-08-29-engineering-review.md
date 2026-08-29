# End-to-end engineering review — 2026-08-29

Reviewed on the Windows build host at `cba7ab5`. ~185k lines: 110k TypeScript, 24k Rust, 27k Node
tooling, 3.5k C++ in the engine module, 8k of patch.

Everything below is either cited to a file or was **measured on this host**, marked **[measured]**.
Where I formed a hypothesis and the measurement refuted it, the refutation is recorded — that is the
more useful half.

---

## Verdict

**The anti-detect engine is in better shape than the project's own documents claim, and the release
engineering is in worse shape than anything else here.** Those are not equally weighted: the engine
is the hard part and it is largely right; distribution is the easy part and it has shipped
user-visible breakage four times in four days.

Two findings that change the picture:

* **The network layer — never measured in this project — passes.** JA3-normalised, JA4 and the
  Akamai HTTP/2 hash are byte-identical to stock Chrome 152 on this host. The two patches the series
  lists as unwritten are **not needed**.
* **The canvas farble is sound**, including against the reversal attack the audit register describes
  and against the float-format bypass I went looking for and did not find.

The things most likely to make this product fail commercially are an unsigned installer, a
single-origin download path with no CDN, and a release process that has repeatedly shipped artifacts
that disagree with the tree they came from.

---

## 1. "Kernel level" — the terminology, and what this actually is

**This product makes no OS-kernel-level anti-detect claim, and should not.** The only place the word
appears as a *product claim* is `apps/web/.../site-footer.html:8` — *"applied inside the browser
kernel — never by a JavaScript overlay"* — which is the industry's other sense of the word: 内核 /
browser kernel, meaning the engine core.

The word does appear elsewhere in source, and correctly so, which is worth separating out rather than
glossing:

* `apps/desktop/src-tauri/src/lib.rs:1257-1301` reads
  `/proc/sys/kernel/unprivileged_userns_clone` to decide whether Chromium can get its
  **user-namespace sandbox**. That is genuine OS-kernel interaction and it is good work: the naive
  alternative is a blanket `--no-sandbox`, which is both a security hole and a fingerprint tell. The
  code disables the sandbox only where the kernel provably cannot provide one, and there is a test
  named for that invariant.
* `sidecar.rs:49` refers to the kernel closing job-object handles on process exit — accurate.
* The canvas, audio and Gaussian-blur "kernels" are math kernels.

None of these is kernel-level *fingerprinting*, which is the claim that would matter.

That distinction matters because the two mean very different things to a buyer, and only one is
defensible:

| | what it would mean | verdict |
|---|---|---|
| OS-kernel-level | a driver or hooking rootkit intercepting syscalls | wrong for this product: unsignable on Windows without an EV cert and WHQL, breaks on every patch Tuesday, and is itself a far louder fingerprint than the browser it hides |
| **browser-kernel-level** | native C++ inside a Chromium fork, before any JS can observe it | **what this is, and the correct choice** |

The architecture is right and the README states it precisely: identity is applied in C++
(`//components/lobium_fp/`), never by a CDP or JS overlay, "because an overlay is itself detectable".
That is the correct threat model — `Object.defineProperty` overrides are trivially detectable via
`Function.prototype.toString`, prototype-chain walks, and iframe-fresh-realm comparison. This product
does not do that anywhere, and the 35-patch series is the reason.

**If any marketing copy says or implies OS-kernel-level, change it.** It is not true, and the claim
invites exactly the scrutiny the product cannot survive.

---

## 2. Anti-detect coverage — measured

### 2.1 The network layer: the biggest documented unknown, now closed

`lobium/patches/series:131-133` lists `net/tls-ja3-ja4.patch` and `net/http2-settings-order.patch` as
**NOT YET AUTHORED**, and `docs/STATUS.md` records `networkTls`/`networkHttp2` as unmeasured because
no stock Chrome was pinned to compare a ClientHello against. One is pinned on this host now.

This is the surface that matters most and the one no JS trick can reach: TLS and HTTP/2 fingerprints
are read by the server before a byte of script runs. Cloudflare, DataDome, Akamai and PerimeterX all
key on them.

**[measured]** Lobium vs stock Chrome 152.0.7977.42, same host, same endpoint, four runs of each:

```
                       stock 152                          lobium
ja3n_hash    a3a3161a080b73bda9cc285fb367fcc0   a3a3161a080b73bda9cc285fb367fcc0   MATCH
ja4          t13d1518h2_8daaf6152771_4980c97…   t13d1518h2_8daaf6152771_4980c97…   MATCH
akamai_hash  52d84b11737d980aef856699f885ca86   52d84b11737d980aef856699f885ca86   MATCH
akamai_text  1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p   (identical)       MATCH
```

Raw `ja3_hash` differs on every single connection — but **so does stock Chrome's from its own
previous run**:

```
stock run A   ja3_hash 01d20a8f0a95e74f9d6a558d1d5da7e8
stock run B   ja3_hash 313591ee8328b3343090555fb748ea5a
```

That is GREASE (RFC 8701): Chrome injects random values into the cipher and extension lists, so raw
JA3 is not a stable identifier for Chrome itself. Any detector keying on raw JA3 cannot distinguish
Chrome from Chrome. The normalised forms, which is what real detectors use, match exactly.

**Conclusion: the fork inherits Chrome's network identity unmodified, which is the correct outcome.**
The two unwritten patches are unnecessary and should be struck from the series rather than left
looking like debt — a "NOT YET AUTHORED" note on a surface that already passes will send the next
engineer to build something that can only make it worse.

**One caveat I could not close.** This was measured on a direct connection. Every real profile runs
through a proxy, and the SOCKS/HTTP shim in `packages/proxy` sits in that path. Whether the handshake
survives the shim unchanged is untested, and it is the case that matters commercially. That is the
single highest-value measurement still outstanding in this project.

### 2.2 Canvas: two alleged defects, both closed, one hypothesis refuted

`docs/subsystems/engine-audit.md:119` describes a fatal weakness: the farble delta was a pure
function of `(seed, x, y, channel)`, independent of the pixel value, so `2a − b` recovered the
original **4096/4096 pixels exactly**. A reversible farble is worse than none — it leaks the true
device while advertising that you are hiding it.

**Fixed, and fixed properly.** `lobium_farble.cc:54-60` now perturbs only when `(v + key) % 3 == 0`
and moves the value by one, into a different residue class, so the predicate is false for the result
and a second application is a no-op. The comment names the exact oracle it defeats. Idempotence is
the right property — it kills `getImageData → putImageData → getImageData` recovery at the root
rather than patching a symptom.

The register's second canvas finding — that the 8-bit kernel walked float16 buffers at the wrong
stride, corrupting the left half of each row and producing `alpha = 1.00098`, which no honest
readback can produce — is also fixed, by a colour-type guard at each hook site.

**That guard looked like it created a bypass, and I spent the measurement to check.** It skips
farbling entirely for non-8888 canvases, and `ImageDataPixelFormat`/`CanvasFloatingPoint` are stable
in M152, so a fingerprinter could plausibly ask for float and read pristine pixels.

**[measured] It does not.** Two personas, identical geometry-only scene (no text, so font differences
cannot confound it), genuine `colorType: "float16"` canvas confirmed via `getContextAttributes()`:

```
                        win-01      win-02
8-bit canvas            df559d01    674d2248    differs
float16 canvas → u8     f929d10e    2a641b26    differs
float16 canvas → f16    19037f5e    e68adf05    differs
```

Seed-dependent on every path. The bypass does not exist. I record this because my first, uncontrolled
version of the test *included text* and would have let me claim a bypass on what was actually font-pack
variation.

### 2.3 What is genuinely still missing

From `lobium/hooks.md` and the register's "Known, unfixed" section, cross-checked against the tree:

| gap | severity | note |
|---|---|---|
| `getCapabilities()` returns nothing for persona media devices | **high** | one call, no permission, and the persona's own `enumerateDevices` entries answer empty. Register calls the fix "mechanical but large" |
| Android tablet + Pixel 10 have no hardware templates | medium | derivation **fails closed** rather than shipping a rotated phone — the right call |
| `navigator.gpu` on a GPU-less host | medium | `webgpu-availability.patch` fixes it on Linux; **[measured] it does not take effect on Windows** — with the explicit `--enable-unsafe-webgpu` switch *and* `forceFallbackAdapter: true`, Dawn returns null anyway, so the patch is not at fault and Windows needs a different remedy |
| Android `(pointer: coarse)` / `(hover: none)` | medium | comes from CDP emulation, not the binary — contradicts the product's own "never by a CDP overlay" principle |
| 25 `UNVERIFIED` findings in `engine-audit.md` | unknown | unverified is not the same as false; this is unmeasured surface area |

---

## 3. Engineering standards

### 3.1 What is genuinely good — and it is worth saying plainly

The measurement culture here is better than most commercial teams I would expect to review.

* **Adversarial verification is the norm.** The 2026-08-23 register raised 94 claims, verified 40,
  and **records the 19 refutations** — "we checked and it is fine" preserved with the same weight as a
  fix. That discipline is rare and it is the reason this codebase can be trusted about itself.
* **A three-verdict conformance model.** `fingerprint-conformance.mjs` distinguishes MATCH / MISMATCH
  / **VACUOUS**, where vacuous means the observed value agreed with the persona *and* with the host,
  so the run proved nothing. Most fingerprint test suites cannot tell those apart and quietly report
  green.
* **The capability contract is a genuinely good piece of design.** The binary declares its own hooks,
  the sidecar probes the exact binary it will spawn, and a mismatch is fail-closed in all three forms
  with no degrade path. The rationale is right: every hook fails *open*, so a leaked profile looks
  exactly like a working one until the account is banned — a browser that refuses to start is the
  cheaper failure.
* **Comments explain the failure that motivated the code.** Repeatedly: the `TZ`-is-POSIX-only note,
  the `windowsHide:true` measurement, the `concurrent_links` assertion. This is institutional memory
  in the right place.
* Coverage is real: 142 JS/TS test files, 32 Rust test modules, 11 gates, 11 CI jobs, and the native
  kernel has property tests (`canvas_farble_properties.cc`, `audio_farble_properties.cc`) — the
  audit's `no-native-tests-for-kernel` finding is closed.

### 3.2 Where it falls below standard

**Release engineering is the weak limb, and it is not close.** In four days:

| what shipped | how it was caught |
|---|---|
| Windows engine with no device-frame code | a user noticed Android profiles had no phone stage |
| installer pinning a superseded engine digest → first run looped forever | a user hit it |
| manifest naming a URL that returned 404 and had never been uploaded | I checked the URL |
| the build script's own banner announcing a correct build as broken for a day | I read the log |

The pattern is one thing: **artifacts that disagree with the tree they were built from**, with no gate
that binds them. The individual fixes have landed, but the class has not been closed. Two concrete
gaps remain:

* Nothing stamps an archive with the source revision it was built from and checks it at publish time.
  The device-frame incident was diagnosed for a day as "built before the fix" when the truth was "built
  from an older tree than the commit that published it" — a provenance failure that a stamp would have
  made unmissable.
* `Compress-Archive` is not reproducible (it embeds timestamps), so the Windows engine archive cannot
  be rebuilt to the same digest. The Linux side has fixed this on its own path
  (`tar --sort=name --mtime=@0 … | gzip -n`, verified by building twice); Windows has not.

**Validation has a structural blind spot: no real GPU exists anywhere in this project.** Both build
hosts are VMs on SwiftShader. Every detector report and every conformance run is a software-rendering
capture, which the project's own `gate.mjs` is written to reject as a false pass. This is not a
criticism of the engineering — it is a missing input, and it is the reason a whole class of question
(does a spoofed GPU hold up against a real driver? is the WebGPU adapter coherent?) is unanswerable
today. **One cheap GPU host would retire more risk than any code change on this list.**

**Documents drift from the code they describe.** `STATUS.md` claimed the Windows font path "fails
open" when it demonstrably hangs the browser; `hooks.md` made three false statements about
`device-frame`; the register's `navigator.gpu` entry is superseded. This is corrosive in a project
whose central artifact is a claim about what it detects as — every stale line spends the credibility
that the good measurement work earns.

### 3.3 Security posture — spot-checked, no findings

Local automation API is loopback-bound with bearer auth and a DNS-rebinding `Host` guard; secrets are
encrypted at rest across three modules with OS-keychain custody; a CSP is declared; proxy credentials
are explicitly excluded from the native config file (`lobium-config.ts:79,128,250` — "credentials
never touch this file") and passed out-of-band; `gitleaks` runs in CI. I found nothing to fix here in
the time I spent, though this was a spot-check and not an audit.

---

## 4. What could make this product poor

Ranked by expected damage, not by how hard they are to fix.

1. **The installer is unsigned.** Every Windows user meets a SmartScreen warning on first run, on a
   product whose entire premise is trustworthiness. This will cost more installs than any fingerprint
   defect will cost accounts. An OV certificate is a few hundred dollars and a week of reputation
   build-up.
2. **One origin, no CDN.** The brief records 78 MB/s to a well-peered network and 5.6 MB/s to an
   ordinary one from the same box on the same day — a 14× spread on a ~290 MB engine. The bundled
   installer moves *when* the bytes arrive, not how fast. That origin is also a single point of
   failure for first run.
3. **Provenance is not enforced between artifact and tree.** See §3.2. This class has produced four
   incidents; the fifth is a matter of time.
4. **No real-GPU validation anywhere.** A structural gap in the evidence, not a bug.
5. **`getCapabilities()` returning empty** for persona devices — a one-call tell with no permission
   prompt.
6. **The first profile launch after a fresh install does nothing.** **[measured]** `code=0` with a
   pid, zero engine processes, `stop` reports "not running"; the immediate retry always works.
   Reproduces on **both** the bundled and the web installer, so it is the product on a fresh install,
   not bundling. This is a new user's very first click, and the app reports success.

---

## 5. What I would do next, in order

1. **Buy a code-signing certificate.** Nothing else on this list changes a purchase decision as much.
2. **Measure TLS/JA3 through the proxy shim.** §2.1 closed the direct-connection case; the proxied
   case is how every real profile runs, and it is one afternoon of work with the harness that now
   exists.
3. **Fix the first-launch failure.** It needs the sidecar's stderr from that launch, which currently
   goes to `tracing` and not to a file — which is itself the thing to fix first.
4. **Stamp archives with their source revision and verify at publish.** Closes the incident class in
   §3.2 rather than its instances.
5. **Strike the two unwritten `net/` patches from the series** and record the measurement in
   `STATUS.md`. They are not debt; leaving them listed invites someone to build something that can
   only regress a passing surface.
6. **Get one machine with a real GPU.**
7. Reconcile `STATUS.md`, `hooks.md` and the two registers against the tree, and put a date on each
   claim.

---

## Scope

I reviewed the engine fork, the fingerprint and launcher packages, the desktop shell, and the
release/CI path in depth, and spot-checked security. I did **not** review the NestJS backend, billing,
the Lobee agent, or the Angular site beyond the downloads catalog — those are substantial subsystems
and deserve their own pass.
