# Spec — Proxy Subsystem (Lobster Browser)

> **Scope:** everything about how Lobster attaches, tests, scores, rotates, chains, and
> leak-protects proxies — and how the proxy's exit IP drives fingerprint geo-coherence.
> **Owner:** Proxy is a **P0 pillar** (MASTER_PLAN §4 Pillar 2). Utilities live in
> `packages/proxy`; the per-profile attach + control plane lives in the Rust desktop core;
> engine wiring lives in `packages/engine-runner`.
> **Status posture:** honest about built-vs-planned. Each capability is tagged
> **done** / **partial** / **planned**. The v1 product ships on **bring-your-own HTTP/SOCKS5**;
> chaining, rotation pools, provider APIs, and native leak enforcement are the maturity curve.

**Sibling specs:** geo-coherence hands off to the fingerprint spec ([`docs/specs/fingerprint-parameters.md`](fingerprint-parameters.md),
`applyGeoToFingerprint`). IPC/launch contracts: `docs/contracts/sidecar-ipc.md`,
`docs/contracts/local-automation-api.md`.

---

## 0. Current state (what exists today)

Grounded in `packages/proxy/src` + `packages/shared-types/src/proxy.ts` + the launch path.

| Piece | Where | Status |
|---|---|---|
| `ProxyConfig` / `ProxyType` / `GeoInfo` / `ProxyTestResult` types | `shared-types/src/proxy.ts` | **done** |
| `parseProxy` — URL form + `host:port[:user:pass]` colon form | `proxy/src/parse.ts` | **done** |
| `formatProxyUrl` / `toEnginePlaywrightProxy` | `proxy/src/parse.ts` | **done** |
| `deriveGeoFromExitIp` — lookup **through** proxy (undici `ProxyAgent`) | `proxy/src/geo.ts` | **partial** (HTTP/HTTPS only) |
| `parseGeoResponse` — pure ip-api → `GeoInfo` mapping | `proxy/src/geo.ts` | **done** |
| `testProxy` — latency + geo, never throws | `proxy/src/geo.ts` | **done** |
| `StaticGeoProvider` / `HttpGeoProvider` (`GeoProvider` iface) | `proxy/src/geo.ts` | **done** |
| Geo → fingerprint (`applyGeoToFingerprint`) wired into launch | `fingerprint/src/coherence.ts`, `engine-runner/src/start-profile.ts` | **done** |
| Playwright per-context proxy attach | `engine-runner/src/launch.ts` | **done** |
| SOCKS5 exit-geo lookup | — | **planned** (undici gap, §7) |
| SSH tunnel / TOR types | — | **planned** |
| Chaining, rotation, pools, health monitor | — | **planned** |
| Provider APIs / reseller | — | **planned** |
| ASN reputation / blacklist / datacenter deep checks | `isDatacenter` only (from ip-api `hosting`) | **partial** |
| WebRTC / DNS / kill-switch leak enforcement | `--disable-blink-features=AutomationControlled` only | **planned** |

The two known code-level gaps are already flagged in-source: `deriveGeoFromExitIp` throws on
`type === 'socks5'` (`"SOCKS geo lookup not yet supported"`), and undici's `ProxyAgent` tunnels
over **HTTP CONNECT only** — the SOCKS dispatcher is §7.

---

## 1. Proxy types

### 1.1 Supported type matrix

| Type | Scheme(s) accepted by `parseProxy` | Auth | Exit-geo lookup | Engine attach | Status |
|---|---|---|---|---|---|
| **HTTP** | `http://` + bare `host:port` colon form | user:pass (Proxy-Authorization / Basic) | ✅ `ProxyAgent` CONNECT | ✅ Playwright `server` | **done** |
| **HTTPS** (TLS to proxy) | `https://` | user:pass | ✅ | ✅ | **done** |
| **SOCKS5** | `socks5://`, `socks://`, `socks5h://` | user:pass | ❌ (throws today) → §7 | ✅ Playwright supports `socks5://` server, but **no auth** at Chromium layer | **partial** |
| **SOCKS5h** (remote DNS) | normalized to `socks5` | user:pass | via §7 dispatcher | same as SOCKS5 | **partial** |
| **SSH tunnel** | `ssh://user@host:port` (key or pass) | key / password | via local forward | local `127.0.0.1:N` SOCKS/HTTP forward → attach | **planned** |
| **TOR** | `tor` (managed) or `socks5://127.0.0.1:9050` | control-port cookie | as SOCKS5 | as SOCKS5 | **planned** |

Notes on the current normalization (`schemeToType`): `socks5|socks|socks5h → socks5`,
`https → https`, everything else (including bare colon form) → `http`. When we add SSH/TOR the
`ProxyType` union must widen — see §11 data model.

### 1.2 SOCKS5 vs SOCKS5h — remote DNS

- **`socks5`**: client may resolve DNS locally, then send the IP. **Leaks** the intended host to
  the local resolver → a DNS/geo tell.
- **`socks5h`**: hostname is sent to the proxy; **DNS resolves at the exit**. This is what we want
  for coherence (§6 remote DNS). Lobster **normalizes SOCKS to `socks5h` semantics** at attach time
  and passes `socks5h://` where the transport supports it. **Status: planned** (today both collapse
  to `socks5`).

### 1.3 SSH tunnel (planned)

Local-forward model: spawn `ssh -N -D <localPort> user@host` (dynamic SOCKS) or `-L` (single port),
then attach the profile to `127.0.0.1:<localPort>`. Fields: `sshHost`, `sshPort` (22),
`sshUser`, `sshAuth = {password | privateKeyPath | privateKeyPem + passphrase}`,
`localForwardPort` (0 = auto-pick). Health = "is the local listener up + tunnel alive". Kill the
child on profile stop.

### 1.4 TOR (planned)

Managed Tor process (or user-supplied `127.0.0.1:9050`). Per-profile **circuit isolation** via
`IsolateDestAddr` / a unique `SOCKS username:password` pair per profile (Tor treats distinct
socks creds as separate circuits). Control port (`9051`) `NEWNYM` for a fresh exit. Exit geo is
whatever Tor gives — coherence still runs, but users are warned exits are volatile.

### 1.5 Per-profile binding

- A profile carries **one** `proxy?: ProxyConfig` (inline) **or** a `proxyId` reference resolved
  from the proxy store (`Profile.proxy` today is inline; the reference form is §11). **done (inline)**.
- Binding is **1:1 at launch** but a proxy row may be **shared** across profiles (pool semantics, §8).
- The proxy is attached at the **browser-context** level so every request from that profile —
  including subresources and workers — egresses through it. No per-profile OS-level routing.
- Auth is passed to the engine via Playwright's `{server, username, password}`
  (`toEnginePlaywrightProxy`). **Chromium SOCKS5 auth caveat:** Chromium does not support
  authenticated SOCKS5; for authed SOCKS we must front it with a **local HTTP→SOCKS shim** (§7) and
  attach the profile to the shim. **planned**.

### 1.6 Auth methods

| Method | Applies to | How | Status |
|---|---|---|---|
| Basic `user:pass` (URL userinfo) | HTTP/HTTPS/SOCKS5 | `formatProxyUrl` percent-encodes; `ProxyAgent` sets `Proxy-Authorization` | **done** |
| IP-whitelist (no creds) | any | provider allowlists our egress IP; config has no creds | **done** (nothing to store) |
| SSH key / password | SSH | `sshAuth` union | **planned** |
| Tor control cookie | TOR | control-port auth | **planned** |

---

## 2. Chaining (multi-hop) + rotation

### 2.1 Proxy chaining (multi-hop) — **planned**

Goal: `client → hop1 → hop2 → … → exit`, so the visible exit IP is several hops removed. Data model
adds `chain?: ProxyConfig[]` (ordered; last element is the exit whose geo drives coherence).

Implementation options (decision pending, see §12):

| Approach | Mechanism | Pros | Cons |
|---|---|---|---|
| **Local chain daemon** | a local mitmproxy/`3proxy`/`gost` process that dials hop1→hop2→…; profile attaches to `127.0.0.1:N` | works for HTTP+SOCKS, uniform | extra process per chain |
| **SOCKS-over-SOCKS** | dispatcher wraps socks-agent in socks-agent | no extra process | SOCKS-only, fiddly auth |
| **`gost` chain** | `gost -L :N -F hopA -F hopB` | robust, battle-tested | bundle a Go binary |

**Coherence rule for chains:** geo is always derived from the **final exit** (run the exit-IP lookup
*through the whole chain*), never an intermediate hop. Latency budget compounds — surface per-hop
latency in `testProxy` when chained.

### 2.2 Rotation

| Mode | Meaning | Where implemented | Status |
|---|---|---|---|
| **None (static)** | one fixed exit for the profile's life | default today | **done** |
| **Sticky session** | provider holds the same exit for N min via a session token in the username (e.g. `user-session-abc123`) | encode in `username`; TTL tracked | **partial** (works if user pastes a sticky cred) |
| **Per-request** | new exit each request (provider rotating gateway) | attach to provider's rotating endpoint | **partial** (attach works; we don't manage it) |
| **Per-session (per-launch)** | new exit each browser launch | pick/rotate `proxyId` from a pool at `start` | **planned** |
| **Timed rotation** | rotate every T minutes while running | control-plane timer re-issues session token or swaps pool member | **planned** |
| **On-failure rotation** | rotate when health check fails | health monitor (§8) triggers swap | **planned** |

**Sticky-session encoding** is provider-specific; Lobster stores a `sessionTemplate` on the proxy
(e.g. `"{user}-session-{sid}-time-{min}"`) and fills `{sid}` from a per-profile stable hash so the
same profile keeps the same sticky exit across restarts — a coherence win. **planned**.

### 2.3 Rotation pools

A **pool** is a named set of proxies with a rotation policy. A profile can bind to a pool instead of
a single proxy; `start` resolves the pool → a concrete `ProxyConfig` per the policy (round-robin /
random / least-recently-used / lowest-latency / weighted-by-health). See §8 + §11
(`ProxyPool` entity). **planned**.

---

## 3. Provider integrations + import formats

### 3.1 Sourcing model

MASTER_PLAN §12.3 decision: **bring-your-own (BYO) in v1**, bundled reseller later.

| Model | v1 | Later |
|---|---|---|
| **BYO** — user pastes/imports their own creds | ✅ **done** (parse + test + attach) | polish |
| **Bundled reseller** — Lobster resells residential/mobile/DC and provisions on demand | — | **planned** (marketplace, MASTER_PLAN §11.6) |

### 3.2 Provider taxonomy (for tagging + quality expectations)

| Class | Typical ASN owner | Coherence quality | Notes |
|---|---|---|---|
| **Residential** | ISP ASNs | best (looks like a real user) | preferred for anti-bot |
| **Mobile** | carrier ASNs | best; CGNAT-shared IP is *normal* for mobile | rotating by nature |
| **Datacenter** | cloud/hosting ASNs | weakest — `isDatacenter` flag fires | ok for scraping, risky for anti-bot |
| **ISP / static residential** | ISP ASN, static | strong + stable | premium |

We tag each proxy with a `providerClass` so the UI can warn when a datacenter proxy is bound to an
anti-bot-sensitive profile.

### 3.3 Import formats (parser support)

| Format | Example | Status |
|---|---|---|
| **URL** | `socks5://user:pass@host:1080` | **done** (`parseProxy`) |
| **`host:port`** | `1.2.3.4:8080` → defaults to HTTP | **done** |
| **`host:port:user:pass`** | `1.2.3.4:8080:bob:secret` | **done** |
| **`user:pass@host:port`** (no scheme) | — | **planned** (needs a colon-form branch that detects `@`) |
| **CSV** (header row: `type,host,port,username,password,label`) | bulk paste / file | **planned** (`parseProxyCsv`) |
| **Newline-delimited list** (one proxy per line, mixed forms) | textarea bulk import | **planned** (`parseProxyList` → `ProxyConfig[]`, skip+report bad lines) |
| **Provider API** (fetch a live pool via provider key) | see §3.4 | **planned** |

**Bulk import contract (planned):** `parseProxyList(text): { ok: ProxyConfig[]; errors: {line:number, raw:string, message:string}[] }` — never throws, returns per-line diagnostics so the UI can show "312 imported, 4 failed."

### 3.4 Provider API adapters (planned)

A small adapter interface so provider gateways can be pulled/rotated programmatically:

```ts
interface ProxyProviderAdapter {
  id: string;                 // 'brightdata' | 'oxylabs' | 'iproyal' | 'smartproxy' | ...
  listEndpoints(opts): Promise<ProxyConfig[]>;      // pull current pool
  createStickySession(opts): Promise<ProxyConfig>;  // mint a session-pinned exit
  rotate(cfg): Promise<ProxyConfig>;                // force new exit
  geoTargets?(): Promise<string[]>;                 // supported country/city codes
}
```

Credentials for adapters are stored encrypted (same at-rest scheme as profile blobs). Adapters are
opt-in; the core never phones a provider without a stored key.

---

## 4. Proxy testing + IP quality

`testProxy` is the entry point (never throws → `ProxyTestResult`). Today it returns
`{ ok, latencyMs, geo, error? }` where `geo` is the exit-IP `GeoInfo`.

### 4.1 Signals (current + target)

| Signal | Field | Source | Status |
|---|---|---|---|
| Connectivity (can we reach the exit) | `ok` | request succeeds through proxy | **done** |
| Latency (ms) | `latencyMs` | `performance.now()` around the lookup | **done** |
| Exit IP | `geo.ip` | ip-api `query` (as seen at exit) | **done** |
| Country / region / city | `geo.countryCode/region/city` | ip-api | **done** |
| Timezone | `geo.timezone` | ip-api | **done** |
| Lat / lon | `geo.latitude/longitude` | ip-api | **done** |
| ASN / AS org | `geo.asn` | ip-api `as` | **done** |
| Datacenter/hosting flag | `geo.isDatacenter` | ip-api `hosting` boolean | **done** |
| IP reputation / risk score | *new* `geo.riskScore` | reputation provider (IPQualityScore/Scamalytics/proxycheck) | **planned** |
| Blacklist / DNSBL membership | *new* `geo.blacklists[]` | DNSBL lookups (Spamhaus, etc.) | **planned** |
| Proxy/VPN/hosting classification | *new* `geo.ipType` | proxycheck.io / IP2Proxy | **planned** |
| IPv4 vs IPv6 | *new* `geo.ipVersion` | parse `geo.ip` | **planned** (trivial once field added) |
| Throughput (Mbps) | *new* `throughputMbps` | timed download of a known-size object | **planned** |
| DNS-leak check | see §6 | resolver-echo endpoint | **planned** |

### 4.2 Quality verdict (planned)

Combine signals into a `qualityVerdict: 'good' | 'warn' | 'bad'` for the UI badge:

- **bad**: not reachable, or on a major blacklist, or `riskScore` high.
- **warn**: `isDatacenter === true`, or high latency (> threshold), or IPv6-only when profile
  expects IPv4, or timezone/country mismatch with a user-pinned target.
- **good**: reachable, residential/mobile ASN, low risk, coherent geo.

### 4.3 Geo endpoint

- Default: `http://ip-api.com/json/?fields=status,message,countryCode,region,city,timezone,lat,lon,as,hosting,query`
  (free, minimal field set). `DeriveGeoOptions.endpoint` overrides it (must return the ip-api JSON
  shape). `DEFAULT_GEO_TIMEOUT_MS = 10_000`. **done.**
- Production hardening (**planned**): a resilient provider chain (primary ip-api → fallback
  ipinfo/ipwho) behind `GeoProvider`, plus a self-hosted echo endpoint to remove the third-party
  dependency and rate limits.

---

## 5. Geo-coherence pipeline

**The single most important coherence rule** (MASTER_PLAN §6 "Geo cluster"): the exit IP's geo must
drive the fingerprint's locale cluster. This is **done** end-to-end for HTTP/HTTPS proxies.

### 5.1 Flow

```
proxy ──(lookup THROUGH proxy)──► GeoInfo ──applyGeoToFingerprint──► Fingerprint ──► engine
  deriveGeoFromExitIp(proxy)        {ip,cc,tz,       (fingerprint pkg)      launch
                                     lat,lon,asn}
```

Wired in `engine-runner/src/start-profile.ts`: derive fingerprint from seed → `applyOverrides` →
**if proxy: `deriveGeoFromExitIp` then `applyGeoToFingerprint`** (best-effort: a failed lookup
launches with the seed default rather than blocking) → `launch`.

### 5.2 What geo overwrites on the fingerprint (`applyGeoToFingerprint`)

| Fingerprint field | Derived from | Status |
|---|---|---|
| `locale.timezone` | `geo.timezone` (IANA) | **done** |
| `locale.locale` | `COUNTRY_LOCALE[geo.countryCode]` (fallback: keep existing) | **done** |
| `navigator.languages` | `localeToLanguages(locale)` (e.g. `['de-DE','de']`) | **done** |
| `locale.acceptLanguage` | `languagesToAcceptLanguage(languages)` (q-weighted) | **done** |
| `locale.geolocation` | `{lat,lon,accuracy:100}` when `geo.lat/lon` present | **done** |

**Gaps to close (planned):** `COUNTRY_LOCALE` is a *minimal* map — expand to a full country→locale
dataset (region-aware, e.g. `en-CA` vs `fr-CA`). Add coherence for `Accept-Language` header at the
**network** layer (mitmproxy canonicalization, MASTER_PLAN §3) so the HTTP header matches
`navigator.languages` byte-for-byte, and derive `screen`/currency/number-format nuances where
providers give city-level precision.

### 5.3 Handoff to fingerprint spec

The consuming side (how each field is *enforced* on the engine — `native` on Lobium vs `JS-safe`
CDP on interim Chromium) is owned by [`docs/specs/fingerprint-parameters.md`](fingerprint-parameters.md) (MASTER_PLAN §5 method legend). This
spec owns the **source** (`GeoInfo`); the fingerprint spec owns the **application**.

---

## 6. Leak protection

The whole point of a proxy is defeated by a leak. Target coverage (mostly **planned**; interim
Chromium does best-effort, Lobium enforces natively):

| Leak vector | Target behavior | v1 (interim Chromium) | Lobium (native) |
|---|---|---|---|
| **WebRTC** (STUN reveals local/real IP via ICE candidates) | ICE candidates == proxy exit IP only; no host/srflx local candidates | **planned** — policy args `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` + `--webrtc-ip-handling-policy`; verify ICE == exit | **native** — force all UDP through proxy or return only the exit srflx |
| **DNS** | resolve at the exit (remote DNS), never the local resolver | **planned** — SOCKS5h + `socks5h://`; for HTTP the proxy resolves; block Chromium async DNS bypass | **native** remote DNS |
| **Local-IP enumeration** (mDNS `.local` candidate hides real IP but still enumerable) | no local candidates leaked | **planned** — obfuscate/disable mDNS host candidates | **native** |
| **Kill-switch** (proxy dies mid-session → traffic falls back to direct) | on proxy failure, block all egress / freeze the profile, never leak direct | **planned** — health monitor (§8) detects, forces context offline / kills tabs | **native** hard-fail closed |
| **IPv6 leak** | if proxy is IPv4-only, disable IPv6 egress so v6 requests don't bypass | **planned** | **native** |
| **Timezone/geo JS leak** | JS `Date`/`Intl`/Geolocation match exit (already via §5) | **done** (via `applyGeoToFingerprint`) | **native** |

**WebRTC verification (CI, MASTER_PLAN §6 "No WebRTC/DNS leak"):** the QA harness launches a profile
behind a proxy and asserts every ICE candidate IP equals `geo.ip`. This is the acceptance gate for
"WebRTC leak check" (MASTER_PLAN Day 5).

**Current reality:** the only stealth-adjacent launch arg today is
`--disable-blink-features=AutomationControlled` (`launch.ts`). No WebRTC/DNS/kill-switch args are set
yet — this section is the plan of record.

---

## 7. SOCKS support in the launcher (the undici gap)

**Problem (in-source, `geo.ts`):** `deriveGeoFromExitIp` uses undici's `ProxyAgent`, which tunnels
over **HTTP CONNECT only**. So SOCKS5 exit-geo lookups throw
(`"SOCKS geo lookup not yet supported (HTTP/HTTPS only)"`). Attaching SOCKS to the *browser* works
(Playwright accepts `socks5://` servers), but our **geo coherence** step silently skips for SOCKS —
a SOCKS profile launches without exit-derived locale.

### 7.1 Plan — SOCKS-capable dispatcher

Add a dispatcher selector inside `deriveGeoFromExitIp`:

```ts
function dispatcherFor(proxy: ProxyConfig): Dispatcher {
  if (proxy.type === 'socks5')
    return socksDispatcher(toSocksOpts(proxy)); // fetch-socks / socks + undici Agent connect()
  return new ProxyAgent({ uri: formatProxyUrl(proxy) }); // HTTP/HTTPS today
}
```

Concretely, use **`fetch-socks`** (or a hand-rolled `undici.Agent({ connect })` whose `connect`
opens a SOCKS5 tunnel via the `socks` package) so the same `request(endpoint, { dispatcher })` path
works for SOCKS. Then delete the `type === 'socks5'` guard.

### 7.2 Authenticated SOCKS for the browser

Chromium **cannot** do authenticated SOCKS5. For authed SOCKS profiles, run a **local HTTP→SOCKS
shim** (e.g. a tiny `3proxy`/`gost`/mitmproxy listener bound to `127.0.0.1:<port>` that forwards to
the authed SOCKS upstream) and attach the *profile* to `http://127.0.0.1:<port>`. The shim holds the
SOCKS creds. This also gives us a natural place for the **kill-switch** (§6) and **chaining** (§2.1).

### 7.3 Acceptance

- `testProxy` returns `ok:true` + exit geo for a SOCKS5 proxy.
- A SOCKS profile launches with locale/timezone matching the exit (parity with HTTP).
- Authed SOCKS works via the shim; browser never sees raw creds.

**Status: planned** (both 7.1 and 7.2).

---

## 8. Per-profile proxy pools + health monitoring

### 8.1 Pools

A `ProxyPool` groups proxies + a rotation policy (§2.3). Profiles may bind a `proxyId` **or** a
`poolId`. At `start`, the control plane resolves a pool → a concrete `ProxyConfig` and records which
member was used (for sticky reuse + health accounting). **planned.**

Policies: `round-robin`, `random`, `least-recently-used`, `lowest-latency`, `weighted-by-health`,
`sticky-by-profile` (stable hash of profileId → member, so a profile keeps its exit).

### 8.2 Health monitoring

A background monitor in the desktop core periodically runs a **lightweight `testProxy`** against
each active/pool proxy and maintains health state:

| Health field | Meaning |
|---|---|
| `status` | `healthy` / `degraded` / `down` |
| `lastCheckedAt` | ISO timestamp |
| `lastLatencyMs` | rolling latency |
| `consecutiveFailures` | drives eviction |
| `lastGeo` | last known exit geo (detect silent geo drift) |
| `uptimePct` | rolling window |

Actions on state change: `down` → evict from pool + (if bound to a running profile) trigger
**on-failure rotation** or the **kill-switch**; `degraded` → deprioritize in `weighted-by-health`.
Backoff so we don't hammer a flaky provider. **planned.**

---

## 9. Testing & QA hooks

- **Unit** (**done**): `parse.test.ts` (URL + colon forms, bad ports, encoding),
  `geo.test.ts` (`parseGeoResponse` field mapping, failure messages) — pure, offline.
- **Integration** (**planned**): `testProxy` against a local throwaway proxy (HTTP + SOCKS) in CI.
- **Leak gate** (**planned**, MASTER_PLAN §6): WebRTC ICE == exit IP; DNS resolves at exit;
  no local-IP candidate — wired into the detector matrix as a blocking gate.
- **Coherence gate** (**partial**): assert launched profile's `timezone`/`locale`/`languages` ==
  values derived from the exit IP.

---

## 10. Endpoints & API surface

Proxy operations exposed by the **local automation API** (Rust Axum, `docs/contracts/local-automation-api.md`)
and mirrored to the cloud where relevant. Envelope: `{code,data,msg}`.

| Method | Endpoint | Body / params | Returns | Status |
|---|---|---|---|---|
| POST | `/proxy/parse` | `{ raw: string }` | `ProxyConfig` (or 400 with message) | **planned** (fn exists) |
| POST | `/proxy/test` | `ProxyConfig` (+ opts) | `ProxyTestResult` | **planned** (fn exists) |
| POST | `/proxy/import` | `{ text, format }` | `{ ok: ProxyConfig[]; errors[] }` | **planned** |
| GET | `/proxy` | — | stored proxies + health | **planned** |
| POST | `/proxy` / PATCH / DELETE | `ProxyConfig` | CRUD | **planned** |
| POST | `/proxy/{id}/rotate` | — | new `ProxyConfig`/session | **planned** |
| GET | `/proxy/{id}/health` | — | health record (§8) | **planned** |
| POST | `/pool` / `/pool/{id}/bind` | pool CRUD + policy | `ProxyPool` | **planned** |

Functions `parseProxy` and `testProxy` are **done** in `packages/proxy`; the HTTP surface that wraps
them is **planned**.

---

## 11. Data model

### 11.1 `ProxyConfig` (current — `shared-types/src/proxy.ts`) — **done**

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | uuid; `parseProxy` mints one if not supplied |
| `type` | `'http' \| 'https' \| 'socks5'` | normalized by `schemeToType` |
| `host` | `string` | |
| `port` | `number` | positive integer, validated |
| `username?` | `string` | percent-decoded on parse |
| `password?` | `string` | |
| `label?` | `string` | human label |

### 11.2 `ProxyConfig` (target extensions) — **planned**

| Field | Type | Purpose |
|---|---|---|
| `type` widened | `+ 'socks5h' \| 'ssh' \| 'tor'` | §1 |
| `providerClass?` | `'residential'\|'mobile'\|'datacenter'\|'isp'` | §3.2 quality warnings |
| `providerId?` | `string` | adapter that owns it (§3.4) |
| `sessionTemplate?` | `string` | sticky-session username pattern (§2.2) |
| `chain?` | `ProxyConfig[]` | multi-hop; last = exit (§2.1) |
| `rotation?` | `RotationPolicy` | `{ mode, intervalSec?, onFailure? }` (§2) |
| `ssh?` | `{ host, port, user, auth }` | SSH tunnel (§1.3) |
| `ipVersionPref?` | `'v4'\|'v6'\|'any'` | leak/attach hint (§6) |
| `localForwardPort?` | `number` | shim/tunnel listener (§7.2) |
| `createdAt/updatedAt` | `string` | store metadata |

### 11.3 `GeoInfo` (current) — **done** + planned fields

| Field | Type | Status |
|---|---|---|
| `ip`, `countryCode`, `timezone` | `string` (required) | **done** |
| `region`, `city` | `string?` | **done** |
| `latitude`, `longitude` | `number?` | **done** |
| `asn` | `string?` (AS org string) | **done** |
| `isDatacenter` | `boolean?` (from ip-api `hosting`) | **done** |
| `ipVersion` | `'v4'\|'v6'` | **planned** |
| `ipType` | `'residential'\|'mobile'\|'hosting'\|'vpn'\|'proxy'` | **planned** |
| `riskScore` | `number` (0–100) | **planned** |
| `blacklists` | `string[]` | **planned** |

### 11.4 `ProxyTestResult` (current) — **done**

`{ ok: boolean; latencyMs?: number; geo?: GeoInfo; error?: string }`. Planned add:
`throughputMbps?`, `qualityVerdict?`, per-hop `chainLatency?[]`.

### 11.5 `ProxyPool` (target) — **planned**

| Field | Type |
|---|---|
| `id`, `name` | `string` |
| `members` | `ProxyConfig[]` (or `proxyId[]`) |
| `policy` | `'round-robin'\|'random'\|'lru'\|'lowest-latency'\|'weighted-by-health'\|'sticky-by-profile'` |
| `health` | per-member health records (§8) |

### 11.6 `ProxyHealth` (target) — **planned**

`{ proxyId, status, lastCheckedAt, lastLatencyMs, consecutiveFailures, lastGeo, uptimePct }` (§8.2).

---

## 12. Open decisions

1. **Chaining engine** (§2.1): local daemon (`gost`/`3proxy`/mitmproxy) vs SOCKS-over-SOCKS
   dispatcher. Leaning `gost` for uniform HTTP+SOCKS chaining and a natural kill-switch home.
2. **SOCKS dispatcher lib** (§7.1): `fetch-socks` vs hand-rolled `undici.Agent` + `socks`. Leaning
   `fetch-socks` for the smallest surface.
3. **Reputation/blacklist provider** (§4): proxycheck.io / IPQualityScore / self-hosted DNSBL — cost
   vs coverage; keep it behind `GeoProvider` so it's swappable.
4. **Reseller timing** (§3.1): BYO only for v1 (confirmed, MASTER_PLAN §12.3); marketplace post-v1.
5. **Kill-switch strictness** (§6): fail-closed hard (kill tabs) vs freeze-and-warn — default
   fail-closed for anti-detect users.

---

## Status vs target

**Built and solid (done):** the coherence spine — parse every common paste format, look up exit geo
*through* the proxy, map it to `GeoInfo`, and rewrite the fingerprint's timezone/locale/languages/
Accept-Language/geolocation before launch — plus HTTP/HTTPS attach, `testProxy` with latency + a
datacenter flag, and a clean `GeoProvider` seam. For **BYO HTTP/HTTPS proxies, v1 coherence works
end-to-end today.**

**Known gaps, planned with a concrete path:** SOCKS5 exit-geo (undici is HTTP-CONNECT-only → §7
dispatcher + auth shim), SSH/TOR types, chaining, rotation pools + health monitoring, provider APIs
+ CSV/bulk import, deep IP-quality (reputation/blacklist/IPv6/throughput), and — most importantly for
anti-detect credibility — **active leak protection** (WebRTC ICE==exit, remote DNS, no local-IP,
kill-switch), which today is only a single automation-flag away from bare. These are the maturity
curve from "usable proxy manager" to "Octo-class proxy subsystem," with Lobium enforcing the leak and
DNS guarantees **natively** once it lands.
