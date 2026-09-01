# Plan: a native C++ Lobster desktop client

Requested by the product owner, who wants the product rewritten in C++ citing Telegram Desktop as
the model for UI/UX and performance.

This plan is built from measurements of this repository, not from general rewrite advice. Every
number below was read off the codebase or the git history. Where an earlier assumption of mine was
wrong, it says so.

---

## 1. The three things to decide before anything else

### 1.1 It is 9–14 months, and that estimate is deliberately generous to the idea

The strongest available calibration is this project's own history:

```
first commit   2026-07-02        commits   250
latest         2026-08-31        authors   ~2 humans
elapsed        60 calendar days, 35 active days
177 of 250 commits carry Co-Authored-By: Claude Opus 5   (71%)
```

~151,000 lines in 35 active days is roughly **3,170 lines/active day**. Textbook estimation (COCOMO
and friends) would price this rewrite at 3–5 years; for this team that would simply be wrong, and
this plan does not hide behind it.

Corrected volume, in C++:

| area | current | → C++ |
| --- | ---: | ---: |
| React UI | 11,710 | ~28–35k |
| Rust core | 13,835 | ~19–21k |
| Sidecar | 12,873 | ~26k |
| Fingerprint *logic only* | 4,343 | ~9k |
| Agent | 11,698 | ~23k |
| crypto/proxy/cookies/types | 3,187 | ~6.5k |

**~111,000–120,000 lines of C++, plus ~50,000 lines of gtest.** At the same team, same intensity,
same AI assistance: **9–14 months**.

### 1.2 The release is one file upload from shipping, and this decision freezes it

The project is not between releases — it is inside one, at the last step. HEAD is a verified Windows
engine build (2h25m, 554 files, 37/37 patches, archive gate PASSED, `en-US.pak` 579 → 0
"Chromium"). `dist-win/lobium-win-x64-152.0.7977.42-brand.zip` exists on disk now.

One 291 MB upload unblocks a validation pass that is already written and waiting. Choosing the
rewrite today means that release, the installer work, code signing and the 13-step matrix all restart
on a new client in 9–14 months.

**Recommendation: ship the current release first.** It is days of work, gated on an upload and a
certificate purchase. The rewrite decision survives contact with a shipped release; the release does
not survive a rewrite decision.

### 1.3 Qt licensing is a structural conflict, not a formality

If the UI uses Qt — and §3 recommends it — the licence is a real constraint:

- **LGPLv3** lets you keep your source closed, but requires dynamic linking, shipping Qt DLLs,
  publishing your Qt modifications, and — decisively — granting users the right to **replace Qt with
  their own build and run the relinked binary**. That is the anti-tivoization clause.
- Lobster is subscription-gated, its EULA grants a revocable licence "subject to your account
  remaining in good standing", and the Rust core carries integrity/checksum code across 10+ files.
  **Any tamper check that refuses to run against swapped Qt DLLs is an LGPL violation.**

That conflict is structural. The commercial path is cheap at this stage: **Qt for Small Business,
~€546/developer/year, capped at 3 licences, requires under €1M annual revenue** — under €1,700/year
for this team. Legal review of the open-source-to-commercial transition rule must precede the first
commit of Qt code.

---

## 2. Two findings that change the product regardless of the rewrite decision

### 2.1 A live defect: persona identity is already unstable

**This is a shipping bug in the current TypeScript product**, found while analysing the port risk.

`rng.pick(arr)` is `arr[rng.int(0, arr.length - 1)]` (`prng.ts:43-48`), and the GPU is picked **by
index** into `WINDOWS_RENDERER_PRESETS` (`device-tiers.ts:208`), which is built at module load by
filtering generated rows (`catalog.ts:109-114`). Changing that array's length or order remaps
essentially every seed. Measured over 5,000 seeds:

```
append ONE row to WINDOWS_RENDERER_PRESETS  -> GPU unchanged for 50.43% of catalog-branch seeds
prepend ONE row                             -> GPU unchanged for 49.91%
across the whole profile population         -> only 58.12% keep their GPU
```

So a routine refresh of `catalog.generated.ts` — a pci.ids update, one new GPU — **silently changes
the machine ~42% of users' profiles claim to be**. `CATALOG_PROVENANCE.retrievedAt` is 2026-07-09;
the next refresh does this.

For an anti-detect browser this is severe: a user's aged, trusted account is suddenly accessed from a
different computer. Fix it now, independent of any rewrite:

- **(a)** persist the derived persona plus a `derivationVersion` alongside the seed, and warn on
  mismatch at launch — ~1 week.
- **(b)** make `pick` index-stable (hash on a stable row key rather than array position) — ~1 week
  plus a population re-derivation study.

### 2.2 Determinism is the migration landmine

There is **no stored fingerprint anywhere**. `schema.prisma:302` persists only `fingerprintSeed`; the
launcher re-derives on every start (`start-profile.ts:261`). The Rust core contains no derivation at
all. A C++ client would become the sole derivation site.

The specific trap:

```ts
h ^= str.charCodeAt(i);        // prng.ts:7  — UTF-16 code units
h = Math.imul(h, 16777619);
```

`charCodeAt` returns **UTF-16 code units**. A C++ port iterating UTF-8 bytes or UTF-32 code points
produces a different hash for any non-ASCII input, and therefore a different persona. Beyond the
hash, the persona depends on the **exact call sequence** of `pick()`/`int()`/`float()` in
`derive.ts` — reorder two draws while refactoring and every profile changes identity.

There are **no golden vectors today**; the existing suite proves self-consistency, not cross-version
identity. A differential-equivalence harness (TS and C++ derivations compared over a large seed
population) is **2–3 weeks and is not currently in anyone's scope**. Skipping it risks mass account
loss at cutover with no rollback.

**Mitigation that removes most of this risk: keep `packages/fingerprint` in TypeScript.** It is 88%
generated data and only ~4,343 lines of logic, and the Windows installer already vendors `node.exe`.
Porting it buys little and risks everything.

---

## 3. UI: what to build on

**Correcting the owner's premise, accurately:** Telegram Desktop is C++, but it does not use stock Qt
Widgets for its look — it paints its own controls in a custom `ui` layer built over Qt as a platform
abstraction. Its beauty comes from that custom painting, not from the toolkit's stock widgets.

**Recommendation: Qt 6 Widgets as a platform layer only, custom-painted**, under the commercial Small
Business licence — mirroring exactly what Telegram does.

Eliminated, with repo-specific reasons:

- **Skia directly** — the repo does build Skia, and `lobium_profile_icon.cc` uses it directly, but
  nobody paints an application with bare Skia: no text layout, no widgets, no input, no IME.
- **Chromium's `ui/views`** — 1,139 files, BSD-licensed, but the API is internal with no stability
  guarantee, and it couples every client release to the fork's rebase cadence.
- **WinUI 3 / WinRT** — deployment and versioning cost, Windows-only lock-in.
- **Dear ImGui** — immediate-mode; wrong for a document-shaped settings UI.

### The UI is bigger than the scope line said

11,710 lines undercounts it by ~4,163: `NewProfileForm.tsx` alone is **1,940 lines** (24 inputs, 12
selects, 53 `onChange`, 21 `useState`), and the coherence logic behind it lives in a separate
**867-line** `profileDraft.ts`. `ProfileList.tsx:400` is a bare `profiles.map()` with **no
virtualization**, while the design tokens note users "run hundreds of profiles".

**Do the two-day virtualization fix on the existing React list now.** It removes the one real
performance complaint while any C++ programme runs, and stops the rewrite being judged against a
straw-man baseline.

---

## 4. Sequencing: the UI goes LAST

**I previously suggested starting with the UI. That was wrong, and the measurements say so.**

The UI is 0.5% of the shipped payload and has **zero tests**. The sidecar is **89 MB** of payload and
has **8,631 lines of tests** to port against. Starting with the UI means rebuilding the largest
untested surface in the least familiar toolkit with no regression net.

| Phase | What | Weeks | Ships |
| --- | --- | ---: | --- |
| 0 | Freeze contracts, stand up CMake/gtest, build golden vectors | 2 | A gate, not a feature |
| 1 | `lobsterd.exe` — headless C++ core inside the existing installer | 6–8 | Runs alongside Node |
| 2 | Absorb the launch path; delete `node.exe` from the installer | 10–14 | −89 MB payload |
| 3 | Absorb the Rust core: store, crypto, sync, snapshot | 12–16 | Byte-compatible or nothing |
| 4 | Native UI, in slices against a stable core | 10–14 | The visible win, last |

**Do not port the agent.** Architectural decision 0002 already firewalled it; that firewall is
permission to leave it in TypeScript.

### The seam already exists

The sidecar contract is **14 methods of newline-delimited JSON over stdio** (`sidecar.rs`). A C++
client can drive the existing Node sidecar unchanged while the UI is rebuilt, and a C++ sidecar can
be driven by the existing Rust core. The codebase is already shaped for a phased migration.

**Hard coexistence constraint:** port 53211 and `profiles.sqlite` are **single-owner**. Two clients
cannot run simultaneously; phases must swap, not overlap.

---

## 5. What must be byte-exact or users lose data

Six formats, no negotiation:

1. **LBv1 envelope** — `"LBv1"(4) | key_id(16) | alg(1) | nonce(12) | ciphertext | tag(16)`,
   AES-256-GCM, **no AAD** (`blob_crypto.rs:20-105`).
2. **HKDF-SHA256 ladder** — salt is empty; info labels are byte-exact
   (`b"lobster/pck/v1:" || profile_id`, `b"lobster/pck-key-id/v1:" || profile_id`), and the id is the
   **server's**, not the local `prf_…`. Get either wrong and every synced profile on every account
   becomes undecryptable.
3. **`lbsec1:` cell format**, 4. the canonical-JSON writer (a C++ writer that renumbers floats breaks
   profile import), 5. the SQLite schema, 6. the sync wire envelope `{code,data,msg}` — where
   **HTTP 200 can mean failure**.

Deliverable: a **cross-implementation vector suite** — fixtures produced by the Rust and TS
implementations, checked byte-for-byte by the C++ code. ~800 lines, 2 dev-weeks, and the cheapest
insurance in this plan.

### One item with no library

`proxy-auth-adapter.ts` — the loopback authenticated-proxy shim. **No mature C++ equivalent exists**;
it is a 600–900 line rewrite, and it carries the failure-classification fix from 2026-08-30 that
stops one blocked domain killing the browser. That fix, and the exit-observation fix beside it, **do
not survive a naive port** — they are subtle and were each found the expensive way.

Also: **31 CI validation harnesses import `engine-runner` as a JS library.** The port must keep a
scriptable entry point or that entire validation estate breaks.

---

## 6. Recommendation

1. **Ship the current release.** Days, not months. One upload.
2. **Fix §2.1 now** — persona instability is a live defect, ~2 weeks, independent of any rewrite.
3. **Virtualize the React profile list** — 2 days, removes the real performance complaint.
4. **Buy the Qt Small Business licence and get legal review** before any Qt code is committed.
5. **Then, if still wanted, run the phased plan in §4** — sidecar first, UI last, keeping
   `packages/fingerprint` in TypeScript.

**On the stated goals, honestly:** desktop performance is *not* a measured problem — profile launch
time is dominated by Chromium startup and font staging, neither of which a C++ client touches. The
real wins are the **89 MB Node runtime** (also a fingerprintable artifact) and total UI control. Both
are genuine. Neither requires rewriting the fingerprint engine or the agent.

The strongest honest case *for* the full rewrite: one binary, one language, no runtime to fingerprint
or ship, and a UI ceiling set by the team rather than by a framework.
