# The phantom launch — two proven kill paths, 2026-08-30

**Symptom.** The first profile launch after a fresh install reports success — `code=0` and a pid —
and then nothing is there. No engine process, and `stop` answers `profile <id> is not running`. An
immediate retry always works. Reproduced on both installers, so it is the product, not bundling.

Two independent mechanisms were found that each kill the browser *after* the launch has been
reported successful. Both are reproduced, and both are fixed here. **Be precise about what that does
and does not settle:**

| | proven | explains "retry works"? |
| --- | --- | --- |
| **Cause 1** — one blocked domain kills the browser | reproduced end to end | **yes**, if the profile has proxy credentials |
| **Cause 2** — staged font pack over MAX_PATH | reproduced end to end | **no** — it is *permanent* for an affected user |

Cause 1 fits every symptom including the retry, but only for a profile with proxy credentials, and
whether the originally reported profile had one was never recorded. Cause 2 produces an identical
visible failure but on *every* launch for any user whose Windows username is 15+ characters, so it
cannot by itself be the reported first-launch-only bug — an adversarial re-test confirmed that a
deliberately broken pack makes the *retry* fail loudly at `verifyStagedNativeFontPack`, which is the
wrong pair of outcomes.

So: two real bugs, both shipped, both fixed. Which one a given user hit is not established, and
**the log now written to `%LOCALAPPDATA%\lobster\logs` is what will settle it** — that logging did
not exist when the symptom was first reported, which is the whole reason it stayed a mystery.

---

## What the symptom already told us

`stop`'s message is literal: `CompositeRunner.stop` throws `profile ${id} is not running`
(`composite.ts:108`) when the profile is absent from its in-memory `running` map. That map loses an
entry in exactly two places — an explicit `stop`, or the `onClose` handler at `composite.ts:88`,
which fires from the launcher's `child.once('exit')`.

And `start_profile_via_sidecar` (`local_api.rs`) refuses to report success unless the sidecar's
result carries a live `debuggerAddress`. So the browser demonstrably came up and answered CDP.

Therefore: **the browser started, was reported as running, and then died.** Everything below is
about what killed it.

### Ruled out, by measurement

| Hypothesis | Result |
| --- | --- |
| The spawned `chrome.exe` exits and hands off to a successor (first-run re-exec, singleton rendezvous) | **Disproven.** A bare-engine reproduction on a virgin `--user-data-dir`, same flags, watched 45s: the spawned pid survives, on both the first run and the retry. |
| The sidecar's Windows Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) reaps the engine | **Disproven.** A Rust probe that creates the identical job, joins it, and launches the engine inside it: CDP comes up and the engine survives the full watch. |
| A slow first launch times out | **Disproven.** `readDevToolsEndpoint` throws on timeout, so that surfaces as a loud error, never as `code=0`. |
| The sidecar died and took the map with it | **Disproven.** The sidecar is spawned once and never restarted; had it died, the *retry* would fail too. It doesn't. |
| `window_show.rs` | Only ever calls `ShowWindow`. It cannot terminate anything. |

---

## Cause 1 — one blocked domain killed the whole browser

`lobium-launcher.ts` wired the proxy shim's failure signal straight to a process kill:

```ts
adapter?.onFailure((message) => {
  if (networkFailure) return;
  networkFailure = `proxy upstream failed: ${message}`;
  signalProcessTree(child, 'SIGTERM');   // the user's browser
});
```

and `proxy-auth-adapter.ts` raised that signal from proxy-chain's **per-request** events —
`requestFailed`, and `tunnelConnectFailed`, which fires for *every* non-200 answer to a CONNECT
(`chain.js:81`: 401/407 map to AUTH_FAILED, everything else to NON_200).

A non-200 on one CONNECT is routine, not fatal. Residential providers answer 403 for blocklisted
hosts, 429 when rate limiting, 502 on a flaky exit node.

**What is proven, and what is inferred.** That a single non-200 CONNECT kills the browser after the
launch is reported successful is *proven* — reproduced below. The first-launch asymmetry is
*inferred*: a fresh Chrome profile CONNECTs to a burst of Google endpoints within seconds of
starting (GCM registration, safe browsing, the component updater, optimization hints) that a warmed
profile no longer makes, so the first launch has strictly more chances to hit a blocked host. That
is a sound mechanism for "retry works", but it was not measured against a real provider — doing so
needs a profile with real proxy credentials, which this host does not have.

**Reproduced** with an upstream that answers 403 for a single host and tunnels everything else:

```
08:16:58  CDP endpoint up                       <- product reports SUCCESS with pid 10908
08:17:00  upstream: 403 for accounts.google.com    (one routine provider block)
08:17:00  shim -> tunnelConnectFailed
08:17:00  *** LAUNCHER POLICY -> SIGTERM the whole browser ***
08:17:05  browser pid GONE
```

It also bought no safety. Chromium runs with `--proxy-server` and no bypass list, so a refused
tunnel surfaces as `ERR_TUNNEL_CONNECTION_FAILED` on that one navigation. Nothing is retried
directly and the real IP is never exposed — there was no ambiguous network state to fail closed on.

### The fix

The adapter now classifies instead of reporting a bare string. `ProxyFailure { message, fatal,
statusCode }`, where `fatal` is true only when the proxy cannot be used **at all**:

* **407/401** — the credentials are wrong. Every request will fail identically and the user has to
  change something, so this is fatal on the first occurrence.
* **Repeated failures with not one successful tunnel** (`UNUSABLE_AFTER = 5`). The `tunnelConnectResponded`
  event supplies the missing bit: if any CONNECT has ever returned 200, the upstream works and later
  non-200s are that provider enforcing policy. If nothing has ever succeeded, it is dead.

Everything else is reported and the browser keeps running.

Verified across all three cases with the real adapter:

| upstream | before | after |
| --- | --- | --- |
| 403 for one host, rest tunnels | browser killed | **alive**, 3 non-fatal reports |
| 407 everywhere (bad credentials) | killed | stopped, on the first event |
| 502 everywhere (dead exit node) | killed | 4 non-fatal, then stopped |

---

## Cause 2 — the staged font pack could exceed MAX_PATH, and the engine then crashed *after* CDP

This one needs no proxy at all.

`stageNativeFontPack` wrote each face to
`<userDataDir>/native-font-packs/<64-hex key>/files/<index4>-<sha12>-<basename>`, and pack basenames
already carry their own 16-hex content prefix
(`379010e87421a883-LiberationSerif-BoldItalic.ttf`, 47 chars). That layout cost **155 characters**
below the user-data-dir, leaving a budget of 105.

The real profile path is `C:\Users\<user>\AppData\Roaming\com.lobster.browser\profiles\prf_<32 hex>`
— 91 characters plus the username. So:

```
13-char user ("Administrator")  -> 259   ok, with ONE character to spare
15-char user                    -> 261   OVER MAX_PATH
20-char user                    -> 266   OVER MAX_PATH
```

`LongPathsEnabled` is 0 on a default Windows install, and the engine calls bare
`::GetFileAttributes` on these files (`IsUnsafePackPath`, `lobium_fonts.cc:43`). An over-length face
reads back as `INVALID_FILE_ATTRIBUTES`, and `FontPackFaces` responds by clearing the **entire**
pack (`faces.clear()`). An empty pack makes `GetCachedMergedFontCollection` return `E_FAIL`, which
`DWriteFontProxyImpl::InitializeDirectWrite` turns into
`CHECK(SUCCEEDED(hr), base::NotFatalUntil::M152)` — and this engine *is* M152, so that CHECK is
fatal: `IMMEDIATE_CRASH()`, `STATUS_BREAKPOINT (0x80000003)`.

Critically, that path runs **lazily**, on the first font resolution — well after
`DevToolsActivePort` is published. So the product reports the launch successful and the browser dies
seconds later. Confirmed by a controlled pair on a short path: pack intact → survives 25s; pack
hidden → CDP up, then `child exit code=0x80000003` with
`lobium_fonts.cc:495 Lobium: configured Windows font pack has no safe loadable files.`

Note this variant is *permanent* on an affected machine, not first-launch-only — every launch of
every profile for any user whose Windows username is 15 characters or longer.

**So it is not, on its own, the reported bug.** An adversarial re-test made the point sharply: with a
pack deliberately broken, the *second* launch does not reach `spawn` at all — `stageNativeFontPack`
→ `verifyStagedNativeFontPack` throws `ENOENT` and the product surfaces a loud launch error. That is
phantom-success-then-loud-failure, where the report is phantom-success-then-working-retry. The
MAX_PATH variant differs only in that Node can read the long paths the engine cannot (Node uses the
Unicode APIs; the engine calls bare `::GetFileAttributes`), so staging keeps succeeding and the
crash simply repeats — permanently, not once.

It is fixed here because it is a real shipped defect that presents to a user as exactly this
symptom, not because it is proven to be the instance that was reported.

### The fix

Staged faces are now named by **index alone**, under a **16-hex** key directory. The engine
enumerates `files/`, filters on the extension and sorts by path — it never parses the name — so a
zero-padded index preserves an ordering the sha and family name never contributed to.

```
before  ...\native-font-packs\<64hex>\files\0005-379010e87421-379010e87421a883-LiberationSerif-BoldItalic.ttf
after   ...\native-font-packs\<16hex>\files\0005.ttf
```

155 → **50** characters below the user-data-dir; the safe budget goes from 105 to 210. A 32-character
username now has 87 characters of headroom. `NATIVE_FONT_PACK_STAGE_VERSION` is bumped to 2, and the
version is inside the content key, so every profile re-stages into a new short directory and no
existing stage is ever read under the new naming.

A test asserts the budget directly, against a synthetic 20-character username.

---

## Also fixed: the exit was not always observed

`child.once('exit')` was registered ~27 lines after the launch's success gate, behind the
cookie-import and mobile-emulation CDP round-trips. Node never invokes a listener for an event that
already fired, so an engine dying inside that window was never observed at all: the teardown never
ran, and `CompositeRunner` kept the handle in `running` **forever** — `stop` reported success while
killing nothing, and every later launch of that profile was refused with `already running` until the
app restarted.

The exit record is now armed immediately after `spawn`, and the launch refuses to return a handle
for a process that is already dead. A test pins that the exit is observed whenever it happens.

---

## Still open

**The engine turns a font-pack problem into a crash after the browser is live.** Fixing the path
length removes the realistic trigger, but a quarantined, deleted or corrupt pack still lands on the
same fatal CHECK, and still does so *after* the product has reported success. Two engine-side
changes would close it properly, and both need a rebuild:

1. `FontPackFaces` should skip a single unreadable entry rather than `faces.clear()`-ing the whole
   pack — one bad file out of 76 currently wipes it.
2. The pack should be validated during browser startup, and a failure should exit cleanly **before**
   `DevToolsActivePort` is published. `waitForEndpointOrExit` already handles that correctly: the
   launcher would report a real launch failure naming the pack, instead of a phantom success.

Long-path-safe (`\\?\`) access in `IsUnsafePackPath`/`FontPackFaces` would be belt-and-braces on top.

**Status reporting swallows the reason.** `reconcile_statuses` (`local_api.rs:361`) unconditionally
demotes every `launching`/`running`/`stopping` row to `idle` before re-marking only what the sidecar
still reports. So when a browser dies, the row the desktop just set to `running` is rewritten to
`idle` with no error attached, and the UI shows a profile that simply never started. Carrying the
exit reason through as an `error` row is what would have made this bug self-diagnosing a week ago.
