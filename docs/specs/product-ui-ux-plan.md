# Product UI/UX + Fingerprint Expansion Plan

> **Status:** planning source of truth for the new product UI requirements declared on 2026-07-07.
> First implementation pass started on 2026-07-07 in the Tauri/Rust desktop app.
> This document maps the requested screens and controls to the current codebase, data model, and
> Lobium engine roadmap.
>
> **Related docs:** [`../PROJECT-STATUS.md`](../PROJECT-STATUS.md),
> [`../PRODUCTION-ROADMAP.md`](../PRODUCTION-ROADMAP.md),
> [`feature-catalog.md`](feature-catalog.md), [`fingerprint-parameters.md`](fingerprint-parameters.md),
> [`data-model.md`](data-model.md), [`proxy.md`](proxy.md).

---

## 1. Product Direction

Lobster's desktop app should feel like a polished, operational workspace: light theme, red as the
main accent, quiet density, and clear status. The UI should not look like a marketing page or a clone of
an incumbent anti-detect browser. It should feel fast, exact, and confident.

Declared product shell:

- **Theme:** light only for the first production design system; red is the major accent color.
- **Header:** top header with the Lobster logo image on the left; notification and profile/account
  buttons on the right.
- **Sidebar:** left navigation with exactly four primary items: **Profiles**, **Proxies**,
  **Templates**, and **Pricing**.
- **Branding:** use image assets for the logo/icon. Do not rely on emoji. Do not introduce "browser" as
  a visual concept in the logo. The lobster should remain natural/curved in brand assets.
- **Interaction style:** dense enough for repeated profile operations, but visually clean and readable.

Current code reality:

- The running app now uses the light/red shell with the selected generated PNG logo, top header
  notification/profile controls, and the required four-item sidebar: `Profiles`, `Proxies`,
  `Templates`, `Pricing`.
- `Profiles` has a dense table, search, engine/OS/status/proxy/tag filters, metrics, create action,
  Trash restore/permanent-delete, Playwright UI smoke coverage, and preserved launch/stop/fingerprint/
  edit/clone/password/delete flows.
- `NewProfileForm` is now a modal wizard with `General`, `Fingerprint`, `Cookies`, `Security`, and
  `Extensions` categories. Native-Lobium-supported fields and launch policy fields are persisted and sent
  through the sidecar launch contract; legacy CDP support is internal/test-only and must not be presented
  as production engine depth.
- `Proxies` and `Templates` now have local Tauri/SQLite stores. The proxy page can add/list/check stored
  proxies through Rust IPC, templates can be created/listed locally, and templates can seed profile
  creation. Pricing remains UI-only until backend billing is wired.
- Shared TypeScript types, local Tauri SQLite, desktop API, and sidecar IPC now include the first schema
  vocabulary for OS version, proxy/template references, cookie import drafts, extension refs, WebRTC
  policy, hardware noise, media devices, renderer policy, stored proxies, stored templates, and profile
  password protection. Backend DTOs and encrypted secret storage still need the same expansion.

---

## 2. Information Architecture

### 2.1 App Shell

Required first viewport:

```text
+------------------------------------------------------------------------------+
| logo + product name                                      notifications avatar |
+---------------+--------------------------------------------------------------+
| Profiles      | page toolbar + filters + primary action                       |
| Proxies       | main workspace                                                |
| Templates     |                                                              |
| Pricing       |                                                              |
+---------------+--------------------------------------------------------------+
```

Header requirements:

- Left: horizontal Lobster logo image, sized for a compact app header.
- Right: notification icon button, profile/avatar button, optional plan/status badge.
- Header must not duplicate sidebar navigation.

Sidebar requirements:

- Four stable items only: `Profiles`, `Proxies`, `Templates`, `Pricing`.
- Each item uses a simple icon plus text.
- Active item has a red-accent indicator and light background.
- Footer may show version/build status, but it must not clutter the main nav.

### 2.2 Profiles Page

The Profiles page is the main workspace.

Required elements:

- Profile list/table of created profiles.
- `Create Profile` primary button.
- Search and filters: OS, proxy, tags, status, Lobium build/status.
- Row/card actions: one primary launch/stop button plus a three-dot menu containing edit profile,
  clone, set/remove password, and move to trash.
- Status indicators: idle, launching, running, stopping, error.
- Engine badge: Lobium build/status only. Chromium must not appear as a production engine choice.
- Proxy/coherence indicator: no proxy, proxy OK, proxy warning, proxy mismatch.

Recommended layout:

- Default to a table for scalability.
- Optional compact card/list mode later.
- Keep repeated data dense: profile name, OS/version, proxy country, tags, status, updated/last launch.

### 2.3 Create Profile Wizard

The current inline `NewProfileForm` should become a modal or drawer wizard. Required categories:

1. **General**
   - Profile name.
   - Description/notes.
   - Proxy selector.
   - Tags.
   - Optional template selector once Templates exists.

2. **Fingerprint**
   - User Agent (**read-only**, derived from Operating system + Lobium Chrome version).
   - Operating system: Windows | macOS Intel | macOS Arm | Linux | Android.
   - OS version (Win 10/11; macOS 13/14/15/26; Android 13→latest; Linux distro labels).
   - Screen resolution (Windows / macOS incl. Retina; **not** shown for Android).
   - Android Device Type + Device Model (verified Play CSV; desktop launch fail-closed).
   - Fonts: mode `real | manual | based_ip` + verified OS catalog (Win 300+, Mac 1000+; Linux deferred).
   - Language / Timezone / Geolocation / WebRTC: each `real | manual | based_ip`.
   - CPU cores / RAM size.
   - WebGL renderer: verified catalog presets (Win 300+ with PCI IDs; Mac 200+; Linux deferred).
   - Hardware Noise checkboxes: WebGL, Canvas, Audio, Client Rects.
   - Media Devices: camera / microphone / speaker counts.

3. **Cookies**
   - File picker for `.txt` and `.json`.
   - Drag and drop area.
   - Plain-text paste area.
   - Parser preview and error table.
   - Import mode: merge, replace, or create empty.

4. **Extensions**
   - `Add Extension` button.
   - Accept Chrome Web Store link.
   - Validate/store extension ID.
   - Later: install/load unpacked extension into the launched profile.

5. **Review**
   - Show the resolved device story.
   - Show coherence errors and warnings.
   - Block create on hard contradictions.
   - Warn when a selected field is not supported by the current engine.

### 2.4 Proxies Page

The Proxies page has two sub-tabs:

- **My Proxies**
- **Hive Proxy**

Each sub-tab must have an `Add Proxy` button.

Required `My Proxies` behaviors:

- Add one proxy or bulk paste.
- Test proxy.
- Show IP, country, city/region, timezone, ASN, provider class, latency, and quality verdict.
- Assign proxy to profiles.
- Warn when proxy geo conflicts with profile locale/timezone.

Required `Hive Proxy` behaviors:

- Treat this as the future built-in/resold proxy inventory.
- Same `Add Proxy` placement for now, but the data source may differ later.
- Keep provider billing separated from the user-owned proxy store.

### 2.5 Templates Page

Required elements:

- List of created templates.
- `Add Template` button.
- Template editor with:
  - name and description.
  - Lobium build/status policy.
  - default OS/OS version policy.
  - fingerprint policy.
  - proxy policy.
  - default tags.
  - default cookies/extensions behavior.

Templates should feed profile creation and future bulk-create.

### 2.6 Pricing Page

Required elements:

- Current plan and usage.
- Plan cards.
- Profile limit, seats, automation/API limits, Lobium/mobile access, sync access.
- Upgrade/downgrade CTA.
- Billing state: trialing, active, past due, canceled.

Pricing is a first-class app screen in the requested UI, not a hidden settings subsection.

---

## 3. Fingerprint Product Policy

### 3.1 OS Support Policy

The requested OS list is:

- Windows.
- macOS.
- Linux.
- Android.

Current code supports only `windows`, `macos`, and `linux`.

Production policy:

| OS | UI status | Engine status | Notes |
|---|---|---|---|
| Windows | enabled | launchable target | Must be host-calibrated on real Windows hardware. |
| macOS | enabled | launchable target | Must support Apple Silicon and Intel paths separately. |
| Linux | enabled | launchable target | First real-GPU validation target. |
| Android | experimental/planned until engine exists | separate mobile Lobium APK/device track | Requires mobile UA, touch, mobile GPU, orientation, sensors, Android build/version model. See [`android.md`](android.md). |

The UI may show Android in planning/disabled state, but it must not silently create launchable Android
profiles until the Android runner and APK exist. iOS is discarded and must not appear as a target.

### 3.2 Renderer/GPU Policy

The requested renderer picker must not become arbitrary GPU string spoofing by default.

Correct model:

- Primary production path: **host-calibrated renderer** derived from the user's real GPU.
- UI label: `Host GPU`, `Normalized host GPU`, or a validated GPU preset.
- Advanced override: allowed only with coherence warnings and engine support.
- The renderer value must agree with OS, WebGL caps, extension list, shader precision, WebGPU, canvas
  rendering, media capabilities, and real-GPU detector proof.

Examples such as Intel UHD / NVIDIA / AMD are valid as catalog labels, but the engine must not claim a
foreign GPU while pixels/caps/extensions still reveal the real host.

### 3.3 Hardware Noise Policy

User-facing hardware noise checkboxes:

- WebGL.
- Canvas.
- Audio.
- Client Rects.

Engine policy:

- Defaults should be enabled when supported by Lobium.
- Noise must be deterministic per profile, not per call.
- Disabling noise is an advanced action and should show a risk warning.
- Client Rects is not currently implemented and must be shown as planned/unsupported until native support
  exists.

### 3.4 Media Devices Policy

Media device counts must become a first-class fingerprint cluster:

- cameras.
- microphones.
- speakers.

The engine must generate stable device IDs/group IDs per profile and keep labels/counts coherent with
permission state and OS/mobile form factor.

---

## 4. Required Data Model Changes

### 4.1 Shared Types

Add/extend domain types in `packages/shared-types`:

```ts
type OsFamily = 'windows' | 'macos' | 'linux';
type PlannedMobileOsFamily = 'android';

interface Profile {
  description?: string;
  osVersion?: string;
  proxyId?: string;
  templateId?: string;
  cookiesImport?: CookieImportDraft;
  extensions?: BrowserExtensionRef[];
}

interface FingerprintOverrides {
  identity?: IdentityOverrides;
  screen?: Partial<ScreenFingerprint>;
  locale?: Partial<LocaleFingerprint>;
  webgl?: Partial<WebGlFingerprint>;
  fonts?: string[];
  webrtc?: WebRtcPolicy;
  hardwareNoise?: HardwareNoisePolicy;
  mediaDevices?: MediaDeviceProfile;
}
```

The exact type names can differ, but the model must stop treating these fields as UI-only strings.

### 4.2 Local SQLite

The desktop store must persist:

- description/notes.
- OS version.
- proxy reference.
- template reference.
- fingerprint overrides, including hardware noise and media devices.
- cookies import draft/result metadata.
- extension references.

Use additive migrations. Existing profiles must remain readable.

### 4.3 Backend/Postgres

The cloud metadata must gain the same fields, either inside `metadata` initially or promoted to columns
where filtering is needed:

- `engine`.
- `os`.
- `osVersion`.
- `tags`.
- `proxyId`.
- `templateId`.
- `fingerprintOverrides`.

Templates and reusable proxies should become explicit team-scoped entities.

### 4.4 IPC / Sidecar Contract

`StartProfileParams` and the Lobium config need fields for:

- OS version.
- WebRTC policy.
- hardware noise policy.
- media device profile.
- resolved extension list.
- cookie import/injection result.
- host-calibration source when available.

Do not add UI controls without a persistence and launch-path contract, unless the UI marks them as
unsupported/planned.

---

## 5. Required Engine Updates

### 5.1 Desktop Host-Calibration First

The current production roadmap remains correct: real-GPU proof and host calibration come before broad
renderer selection. This new UI plan adds controls, but it does not replace the engine rule:

```text
real host -> calibrated base profile -> per-profile farbling/noise -> proxy geo overlay -> launch
```

### 5.2 Config Channel Expansion

Extend `lobium-fp.json` to carry:

- OS version / platform version.
- WebGL extension list, shader precision, version strings.
- hardware noise policy for WebGL/canvas/audio/clientRects.
- WebRTC policy.
- media device counts and generated stable IDs.
- renderer masking mode.

### 5.3 Native Surface Work

New/expanded native tasks:

- Client Rects farbling.
- Media device enumeration and stable device IDs.
- WebRTC policy enforcement.
- Full OS version and UA-CH platform-version coherence.
- Android family once desktop real-GPU host calibration is stable.

---

## 6. Implementation Milestones

### UX-1 Light/Red Shell

Acceptance:

- App uses a light theme with red accent tokens.
- Header uses the selected image logo asset on the left side of the top navbar.
- Sidebar has exactly Profiles, Proxies, Templates, Pricing.
- Notification and profile buttons exist in the header.
- No emoji branding in production shell.

Implementation status: **done in source** for the desktop React shell.

### UX-2 Profiles Workspace

Acceptance:

- Profiles page shows a scalable list/table.
- `Create Profile` opens the new wizard.
- Search/filter controls exist.
- Existing launch/stop/clone/delete flows remain available through the launch button and overflow
  menu.

Implementation status: **done for the current desktop UI scope**. Table, search, engine/OS/status/proxy/tag
filters, create action, launch/stop, general edit, clone, Argon2-backed password protection, move-to-trash
soft-delete, a Trash modal with restore/permanent-delete, and a Playwright UI smoke are implemented.

### UX-3 Create Profile Wizard

Acceptance:

- General, Fingerprint, Cookies, Security, Extensions categories exist.
- General captures name, description, proxy, tags.
- Cookies supports file picker, drag/drop, and paste text entry.
- Extensions accepts Chrome Web Store links.
- Security shows WebRTC/password controls and unsupported-feature warnings.

Implementation status: **partial**. The category structure exists; native-Lobium policy fields save;
cookie file/drop/paste parsing persists draft metadata; extension references persist; stored proxy and
template selectors feed profile creation. Browser cookie injection and extension installation remain
engine/runtime tasks on the direct Lobium path.

### UX-4 Full Fingerprint UI

Acceptance:

- User can select/edit all requested fields from the product matrix (read-only UA; OS-specific screens/fonts/WebGL; Android device type/model; persona modes; hardware noise/media).
- Unsupported fields are visibly disabled or marked planned (Linux font/WebGL deferred; Client Rects / mediaDevices native consume partial).
- OS version selection exists for Windows / macOS Intel / macOS Arm / Linux / Android.
- WebGL renderer presets come from verified catalogs with PCI/product IDs (see [`fingerprint-catalog-provenance.md`](fingerprint-catalog-provenance.md)).
- Engine choice is Lobium-only (no uncustomized Chromium).

Implementation status: **mostly done (UI + catalog + launch config)**. Create-profile Fingerprint tab matches the matrix; edit path locks engine to Lobium; `lobium-fp.json` carries UA/screen/fonts/WebGL/noise-gated seeds/media policy. Remaining: native clientRects/mediaDevices hooks, Linux catalogs, host-calibration default path, HC-4 deep-GPU extensions.

### PROX-UI-1 Proxy Pages

Acceptance:

- Proxies page has `My Proxies` and `Hive Proxy` tabs.
- Each tab has `Add Proxy`.
- My Proxies supports add/test/list.

Implementation status: **partial**. Tabs, Add Proxy placement, validation, durable local add/list, Rust IPC
proxy testing, row Check actions, and profile assignment exist. Encrypted credential persistence, bulk
paste, provider-backed Hive inventory, and leak/kill-switch proof remain.

### TPL-1 Template Product Surface

Acceptance:

- Templates page lists templates.
- `Add Template` opens a template editor.
- Create Profile can start from a template.

Implementation status: **partial**. Local SQLite list/search/create and create-from-template exist. Richer
template policies, backend sync, and bulk-create remain.

### PRICE-1 Pricing Product Surface

Acceptance:

- Pricing page shows current plan, usage, and upgrade path.
- Plan limits match backend billing config.

Implementation status: **partial UI only**. Plan and usage cards exist; billing backend wiring remains.

### DATA-UX-1 Schema/Contract Expansion

Acceptance:

- Shared types, SQLite, backend DTOs, Prisma metadata, and sidecar IPC can represent the wizard's fields.
- Existing profiles migrate cleanly.

Implementation status: **partial**. Shared types, local SQLite profile/proxy/template stores, desktop API,
and sidecar IPC can round-trip the first additive fields. Backend metadata/DTOs and encrypted local secret
storage still need completion.

### ENG-UX-1 Launch Contract Expansion

Acceptance:

- Sidecar and Lobium config receive the new supported fields.
- Unsupported fields fail closed or are clearly ignored with a surfaced warning.

Implementation status: **partial**. Sidecar launch params and `lobium-fp.json` receive OS version,
WebRTC policy, hardware noise, media devices, renderer policy, and captured WebGL extension/precision/
version fields. Native Lobium still needs to consume the full policy set and fail closed for unsupported
modes; the first-run host probe is still open.

### MOB-1 Android Track

Acceptance:

- Android is modeled as a mobile fingerprint family with coherent UA/touch/screen/GPU/sensors.
- It remains experimental until native mobile engine proof exists.


## 7. Recommended Sequence

The next UI/product sequence should run in parallel with the core real-GPU/host-calibration work:

```text
UX-4 support/status hardening -> ENG-UX-1 native consumption
DATA-UX-1 backend DTOs + encrypted local secrets
PROX-UI-1 bulk/Hive/provider depth -> PROX-7/8 leak + kill-switch proof
TPL-1 richer policies + backend sync
PRICE-1 billing backend wiring
```

Do not wait for every native engine feature before improving the UI, but keep the UI honest:

- Supported fields can be enabled.
- Planned fields can be visible but disabled.
- Risky overrides can be advanced-only with coherence warnings.
- Impossible combinations must be blocked.

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| UI claims support for surfaces the engine cannot enforce. | HIGH | Add support badges and block unsupported launch paths. |
| Arbitrary renderer selection creates WebGL/canvas/caps contradictions. | HIGH | Default to host-calibrated GPU; advanced override only after validation. |
| Android is misrepresented as a desktop launch target. | HIGH | Keep Android disabled until the Android APK/runner/device proof exists. |
| Profile wizard stores data the launch path ignores. | HIGH | DATA-UX-1 and ENG-UX-1 must land before fields become enabled. |
| Light/red redesign becomes decorative rather than operational. | MED | Build dense tables, predictable controls, and clear status over hero-style UI. |
