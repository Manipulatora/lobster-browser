# Phase 1 — the 3D-rendering defect, measured on the Windows host

2026-08-26, Windows build host. Companion to
[`2026-08-26-windows-understanding.md`](2026-08-26-windows-understanding.md).

**Verdict: the defect does not reproduce here, and every mechanism the diagnostic can distinguish
exonerates the engine.** With a full Windows persona attached, our engine renders GitHub's four
section-intro WebGL mascots **byte-identically to stock Chrome 152.0.7977.42 on the same host** —
same SHA-256 on every PNG.

That is the same conclusion the Linux side reached, and for the same reason, which is the part of
this report that matters most: **this host has no GPU either.** The brief was written believing it
did (see §4).

---

## 1. What was run

Engine: `dist-win/lobium-runtime-152.0.7977.42/chrome.exe` — the packaged runtime whose archive
SHA-256 (`1c9c95a6…`) is the one the manifest currently publishes.

Reference: `stock-chrome-reference/152.0.7977.42/win64/…/chrome.exe` — stock Chrome at the **exact
same build number** as our fork, on this machine, same page, same regions. A same-host reference
rather than a memory of one, as the brief asks.

Personas were generated with the new [`scripts/qa-generate-personas.mjs`](../../scripts/qa-generate-personas.mjs)
rather than read out of `%APPDATA%\com.lobster.browser\profiles`, so nothing was driven against the
user's real cookies and logins:

| persona | claimed GPU | screen | why this one |
|---|---|---|---|
| `win-desktop` | NVIDIA GeForce GTX 1050 Ti (D3D11) | 2560×1440 | the ordinary Windows case |
| `android-mobile` | ARM Mali-G78 (OpenGL ES 3.2) | 393×873, dpr 2.75 | the Android case |
| `gpu-mismatch` | NVIDIA GeForce **RTX 5090 Max-Q** (D3D11) | 1920×1080 | the brief asks for a persona whose claimed GPU differs sharply from the host's. On a host with **no** GPU every persona qualifies, so this picks the largest discrete part the seed search can find — the strongest form of the same test |

---

## 2. Results

```
                       draws  GL errors  ext advertised-but-null  MAX_TEXTURE_SIZE adv/exec  varyings
stock Chrome 152         257      0              []                     8192 / 8192 ok          31
lobium no persona         98      0              []                     8192 / 8192 ok          31
lobium win-desktop       252      0              []                     8192 / 8192 ok          30
lobium android-mobile    257      0              []                     8192 / 8192 ok          31
lobium gpu-mismatch      257      0              []                     8192 / 8192 ok          30
```

All four mascots were found, all WebGL contexts were created, and no context reported a creation
error, a shader-compile failure or a link failure in any run.

### 2.1 Pixel comparison — byte-identical

`stock` and `win-desktop` produced the same 95×95 regions, so they compare directly:

```
mascot-0: BYTE-IDENTICAL   stock=4981B   lobium=4981B
mascot-1: BYTE-IDENTICAL   stock=13679B  lobium=13679B
mascot-2: BYTE-IDENTICAL   stock=5463B   lobium=5463B
mascot-3: BYTE-IDENTICAL   stock=2830B   lobium=2830B

sha256(mascot-0.png)  stock = b66b1524b09729fa…   lobium = b66b1524b09729fa…
```

The `android-mobile` and `gpu-mismatch` runs captured 142×142 regions instead, because the persona's
viewport and device-pixel-ratio change the page's own layout. That is expected persona behaviour, not
a rendering difference; both rendered the mascot correctly.

### 2.2 The five candidate causes, one by one

The diagnostic exists to separate five explanations. None of them fires:

1. **GPU not used for WebGL at all** — true on this host (`webgl: unavailable_software`), but stock
   Chrome is equally affected and renders the mascots fine. So this is not what breaks the reporter's
   machine.
2. **Context never created** — refuted. Every `getContext('webgl')` returned a context in every run.
3. **Persona over-claiming a cap the backend cannot execute** — refuted, and this is the strongest
   result here. The RTX 5090 persona advertises `MAX_TEXTURE_SIZE` 8192, not the 16384+ a real 5090
   reports, and a texture allocated at the advertised limit **succeeds**. `MAX_VARYING_VECTORS` is
   advertised as 30 and a program with 30 varyings links. `fingerprint/webgl-runtime-safety.patch` is
   doing exactly what it was written to do: the persona never promises what the live backend cannot
   deliver.
4. **An extension named but not obtainable** — refuted. `extensionsAdvertisedButNull` is `[]` in all
   four runs. (Persona runs advertise 32 extensions against stock's 35; the persona set is a filtered
   Chrome registration-order list, and every one of the 32 hands over a real object.)
5. **Draws landing on nothing** — refuted. 252–257 draw calls and pixel-identical output.

---

## 3. Two defects found while running Phase 1

### 3.1 `diagnose-3d-render.mjs` had a CDP readiness race (fixed)

The script fetched `/json/list` **once**, immediately after `/json/version` answered — but
`/json/version` responds when the browser opens its DevTools socket, which is *before* any page
target exists. On a loaded machine the gap is seconds, so `list.find(t => t.type === 'page')` was
`undefined` and the script died with:

```
TypeError: Cannot read properties of undefined (reading 'webSocketDebuggerUrl')
    at scripts/diagnose-3d-render.mjs:102
```

It passed on an idle host and failed on a busy one — the worst way for a diagnostic to be wrong,
because the crash reads as though the engine misbehaved. This is the same readiness race
`resolveCdpTarget` already handles in the sidecar
(`packages/engine-runner/src/cdp-client.ts`), and it is fixed the same way: poll for a page target,
and report the engine's own stderr if none appears. Both agents were told to run this script, so it
would have bitten the Linux side too.

### 3.2 Windows font isolation does not fail open

`docs/STATUS.md:148-151` says the Windows font path "deliberately fails OPEN (degraded, never wider
than the host)". **Measured: it does not.** An Android persona written *without* a font pack — it
claims Roboto, Noto Sans, Noto Color Emoji, Droid Sans, Google Sans, none of which exist on a stock
Windows host — produces:

```
ERROR:components\lobium_fp\lobium_fonts.cc:535]
    Lobium: restricted Windows character fallback could not be built.
```

and then the browser **never produces a page target at all**. `/json/list` returns only `browser_ui`
entries indefinitely. That is not a degraded launch; it is a browser that starts and does nothing,
explained only by one line in a log nobody reads.

Two things follow. First, this was **my generator's bug, not the product's** — I called
`buildLobiumConfig` directly where the launcher calls `buildLobiumLaunchArgs`, which stages and
verifies a font pack first. I checked a real Android profile's `lobium-fp.json` and it does carry
`fontPackDir`, 41 fallback families and 3 aliases; the generator now mirrors the launcher exactly and
the persona launches perfectly (Android 10 UA, `Linux armv81`, 393×873, `maxTouchPoints` 5,
`ANGLE (ARM, Mali-G78, OpenGL ES 3.2)`).

Second, the failure mode is still worth recording, because the product can reach it: if a font pack
is ever missing, quarantined or corrupt at runtime, the user gets a browser that opens and then
hangs, with no UI-level explanation. The doc's claim that this path fails open is wrong, and the
honest behaviour would be to refuse the launch with a message naming the pack.

---

## 4. Correction to the brief: this host has no GPU

Both Phase 1 and Phase 2 are premised on this machine having a real GPU — *"yours is the only machine
that has one"*. It does not:

```
Win32_VideoController : Microsoft Basic Display Adapter, SeaBIOS VBE(C) 2011, AdapterRAM 0
PnP                   : PCI\VEN_1234&DEV_1111&SUBSYS_11001AF4    (QEMU/Bochs VGA + virtio)
ComputerSystem        : BOCHS_ / BXPC____
NVIDIA / AMD / Intel  : NONE

gpu.featureStatus     : webgl unavailable_software, webgpu unavailable_software,
                        gpu_compositing disabled_software, rasterization disabled_software
glRenderer            : ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader 5.0.0)
```

So the "real-GPU path" the brief wanted tested is not reachable from either host in this project.

**What this does and does not establish.** The engine and the fingerprint layer are now exonerated on
a software backend on *two* different operating systems, with a same-build stock reference on each —
that is a genuinely stronger result than the Linux run alone, and it rules out a whole class of
causes (cap over-claim, extension lies, context-creation failure, draw-path breakage) that would have
shown up regardless of backend. What it cannot do is reproduce a defect that requires a real driver.

**The cheapest way to settle this is not more work on these two boxes.** The report came from a user's
machine. `scripts/diagnose-3d-render.mjs` is read-only, uses a throwaway profile, and now survives a
loaded host; one run of it on the reporter's machine would produce in two minutes the evidence that
neither of these VMs can generate at all.

---

## 5. Artifacts

```
qa-out/lobium-3d-nopersona.json        qa-out/shots-nopersona/
qa-out/lobium-3d-win-desktop.json      qa-out/shots-win-desktop/
qa-out/lobium-3d-android-mobile.json   qa-out/shots-android-mobile/
qa-out/lobium-3d-gpu-mismatch.json     qa-out/shots-gpu-mismatch/
qa-out/stock-3d-nopersona.json         qa-out/shots-stock/
qa-out/personas-p1/                    generated persona configs
```
