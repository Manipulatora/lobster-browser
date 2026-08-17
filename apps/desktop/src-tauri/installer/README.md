# Windows installer assets

Everything the NSIS setup wizard shows, and why each choice was made. Configured in
`../tauri.windows.conf.json`; JSON has no comments, so the reasoning lives here.

## Files

| File | Size | Where it appears |
|---|---|---|
| `installer-sidebar.bmp` | 164×314 | The tall panel on the Welcome and Finish pages |
| `installer-header.bmp` | 150×57 | The strip at the top-right of every other page |
| `LICENSE.txt` | — | The licence page the user must accept |

Both bitmaps are **generated**, not hand-edited: `scripts/gen-installer-art.ps1` builds them from
`apps/desktop/src/assets/brand/_masters`. Re-run it after a brand change rather than editing pixels
nobody can reproduce. Pass `-Preview` to also emit PNGs you can actually look at.

## Why the artwork is what it is

**BMP, 24-bit.** NSIS MUI2 loads these through the Win32 image list, which accepts a
device-independent bitmap and nothing else — a PNG renders as nothing at all, silently. 24-bit
rather than 32-bit because MUI composites the sidebar itself and reads a 32-bit BMP's alpha channel
as garbage, producing a black rectangle.

**The header is light, the sidebar is dark.** MUI draws the page title and subtitle as black text on
the header strip, and the header bitmap occupies only the right-hand end of it. A dark header image
therefore sits next to black-on-white text and looks like a rendering bug. The sidebar has no text
over it, so it carries the full brand treatment.

**The first sidebar attempt failed and is worth recording.** A diagonal dark→violet gradient put the
mark, which is itself violet, on mid-violet — and the logo vanished into a shield-shaped smudge. The
gradient now holds near-black until 52% of the panel height, below the mark, so the logo's light
edges have something to read against while the brand colour still carries the lower half.

**The sheen needed five stops, not three.** A `0 → peak → 0` ramp left a visible diagonal seam: the
gradient's axis is the bounding rectangle's diagonal, which is not the polygon's diagonal, so one end
of the band was still partly opaque where the polygon edge cut it. Transparency is now held across
the outer 30% at both ends, so the highlight fades out before it reaches any edge.

## Why the wizard behaves as it does

**`installMode: currentUser`** — setup never raises a UAC prompt. The app writes only to its own
AppData (profiles, the SQLite stores, the engine runtime) and needs no machine-wide state, so asking
for administrator rights would buy nothing and cost a consent dialog at the user's first contact with
the product. It also lets someone without admin rights on a managed machine install at all.

**One language, selector off** — with more than one language NSIS opens a language dropdown *before*
the wizard, so the first thing a user sees is a bare modal asking a question they did not come to
answer. Add languages when there is translated UI to justify them.

**`compression: lzma`** — slower to build, materially smaller to download. The payload is dominated
by a vendored `node.exe` and the frontend bundle, both of which compress well.

**`webviewInstallMode: embedBootstrapper`** — the Tauri default (`downloadBootstrapper`) fetches the
bootstrapper *at install time*, so an install behind a restrictive network fails partway through
with a network error rather than never starting. Embedding it costs ~1.8 MB and means setup always
reaches the runtime step. It still needs connectivity to fetch the runtime itself on machines that
lack WebView2 — only unpatched Windows 10 and Server images; Windows 11 ships it.
`offlineInstaller` removes even that, but adds ~127 MB to every download for a case most users never
hit.

## Not solved here: code signing

The installer is **unsigned**. Windows SmartScreen will show "Windows protected your PC" to every
user on first run, with a "More info → Run anyway" path that a cautious user will not take.

No amount of configuration fixes this — it needs an Authenticode certificate:

- **OV (organisation validation)**, roughly $200–400/year. Signs correctly, but SmartScreen
  reputation is earned over time and downloads, so early users still see warnings.
- **EV (extended validation)**, roughly $300–600/year, on a hardware token or cloud HSM. Gets
  SmartScreen reputation immediately.

Once a certificate exists, set `bundle.windows.certificateThumbprint` (plus `digestAlgorithm` and
`timestampUrl`) and Tauri signs both the app binary and the installer during `tauri build`. Timestamp
the signature, or every installer already distributed stops validating when the certificate expires.
