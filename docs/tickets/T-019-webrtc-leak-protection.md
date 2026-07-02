# T-019 — WebRTC leak protection + validation-gate integration

**Pillar:** 2 · Proxy Management (leak protection) · **Assignee:** Claude · **Status:** done
**Day:** 5 (mid-sprint integration). **Closes** the "no WebRTC/DNS leak behind the proxy" bar
([MASTER_PLAN §6](../MASTER_PLAN.md) / §13) and wires the previously-declared-but-unwired `webrtc`
validation threshold. Composes with [T-018](T-018-fingerprint-coherence-geolocation.md): T-018 made
the geo/timezone/locale story coherent; T-019 stops WebRTC from blowing that coherence by leaking the
real IP.

## The problem

An anti-detect profile behind a proxy must never leak the real IP via WebRTC. Two vectors:
- **Local IP** — modern Chrome already masks host candidates behind mDNS (`<uuid>.local`), so the
  private IP doesn't leak by default. (Verified: 0 raw private IPs in host candidates.)
- **Public IP** — the real danger. A `srflx` candidate from a STUN server exposes the true public
  IP (IPv4 **and** global IPv6), *bypassing the proxy*. (Verified live: with STUN and no policy, the
  browser emits the host's real `158.220.x.x` **and** `2a02:…` global IPv6.)

## What changed

1. **Proxy-aware WebRTC IP-handling policy** in `buildLaunchOptions`:
   - **proxy set →** `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. WebRTC may only use
     paths routable through the proxy, so it can't reach a STUN server directly — the real public IP
     cannot leak (WebRTC IP == proxy IP). Fails closed: if it can't proxy the UDP, it drops it.
   - **no proxy →** `--force-webrtc-ip-handling-policy=default_public_interface_only` (don't enumerate
     secondary/VPN interfaces on multi-homed hosts). mDNS masking is left on (never disabled).
2. **Non-vacuous validation-gate check** (`webrtcLeakProtected`), addressing the adversarial review that
   the first cut was guaranteed-green by Chrome's mDNS default:
   - **(i) Local masking** — the profile's own host candidates must all be mDNS `.local` (address
     parsed from ICE token index 4; `private4`/`global6`/`public4`/`local6` all count as leaks).
   - **(ii) Public-IP suppression** — a throwaway context launched with `disable_non_proxied_udp` **+ a
     live STUN server** must emit **no** public-IP `srflx` (v4 or global v6). The control
     (`default_public_interface_only` + STUN) *does* leak, so this assertion has teeth without needing
     a real proxy.
   - IPv6 is covered (global unicast `2000::/3`), plus CGNAT `100.64/10` and link-local ranges.

## Acceptance criteria — all met

- [x] Proxied launches force WebRTC through the proxy (no direct STUN path).
- [x] `navigator`/host candidates never expose a raw private IPv4 or global IPv6 (mDNS masking).
- [x] The leak-protection policy provably suppresses the STUN public-IP `srflx` (v4 + v6).
- [x] The `webrtc` threshold is wired and honest (no overstated coverage).

## Verification

- **95 unit tests** green (engine-runner 18 incl. the proxy-aware policy assertion); build/typecheck/prettier clean.
- **Live gate** → `verdict: pass`, `webrtcLeakProtected: true`: `localLeaks: 0`, `suppressionLeaks: 0`
  (control run confirmed the real public IPv4 + global IPv6 *would* leak without the policy).

## Adversarial review

A focused review flagged the first harness cut as **vacuous** (ran without a proxy, `iceServers:[]` so a
`srflx` could never appear, and only prefix-checked the flag) and the IPv6 gap + overstated config. All
fixed: the STUN suppression sub-check now has teeth, IPv6/CGNAT/link-local are classified, and
`thresholds.json` states exactly what is enforced.

## Follow-ups

- **T-019a:** assert `srflx == proxy egress IP` (not the host IP) against a **live test proxy** (CI secret) —
  the one property not verifiable without a real proxy.
- **Lobium:** native WebRTC IP control (belt-and-suspenders beyond the Chromium flag).
- **DNS leak** check (resolver goes through the proxy) — the other half of §6's "no WebRTC/DNS leak".
