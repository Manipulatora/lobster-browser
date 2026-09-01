# The forked NSIS template

`installer.template.nsi` is a fork of Tauri's own NSIS template, wired in via
`bundle.windows.nsis.template` in `tauri.windows.conf.json`. `installer.template.upstream.nsi` is
the pristine upstream copy it was forked from, kept **only** so the next Tauri upgrade is a diff
rather than an archaeology exercise. Nothing reads the `.upstream.nsi` file at build time.

## Why a fork exists at all

Almost everything about this installer's appearance is done from `hooks.nsh`, which Tauri
`!include`s at the top of its generated script — no fork required, and that is the maintainable
route. Exactly one requirement could not be met that way:

**Removing the "Choose Install Location" page.** Its `MUI_PAGE_CUSTOMFUNCTION_PRE` is consumed by
the page macro itself, so there is no way to make it `Abort` from an included hook file. That single
deletion is the entire justification for the fork.

A second edit was added later (suppressing `BrandingText`), because NSIS paints that string onto the
dialog directly rather than only into control 1256 — so hiding the control leaves a doubled ghost of
the text behind, and the only clean fix is at source.

## What is different from upstream

Keep this list current. Everything else must stay byte-identical.

1. **Directory page deleted** — the `; 5. Choose install directory page` block.
2. **`BrandingText " "`** — was `BrandingText "${COPYRIGHT}"`.
3. **Four `MUI_PAGE_CUSTOMFUNCTION_SHOW` defines** inserted before the WELCOME, LICENSE, INSTFILES
   and FINISH pages, plus one before UNPAGE_INSTFILES. These call the per-page painter in
   `hooks.nsh`. They are needed because `MUI_CUSTOMFUNCTION_GUIINIT` fires only once while MUI
   repaints its header and branding controls on every page change — styling applied once is
   repainted over, which is why the interior pages were unreadable before this.

## Upgrading Tauri

The template is **not on disk as source** — `tauri-bundler` is not in `Cargo.lock`; the template is
embedded in the CLI's native binary. To re-extract it for the version you are moving to:

```bash
node -e "
const fs=require('fs');
const b=fs.readFileSync('node_modules/@tauri-apps/cli-win32-x64-msvc/cli.win32-x64-msvc.node');
const start=b.indexOf(Buffer.from('Unicode true','latin1'));
const s=b.slice(start).toString('utf8');
// The template ends at CreateOrUpdateDesktopShortcut's FunctionEnd; the next embedded file
// (FileAssociation.nsh) begins immediately after.
const end=s.indexOf('FunctionEnd', s.indexOf('CreateOrUpdateDesktopShortcut'))+11;
fs.writeFileSync('installer.template.upstream.nsi', s.slice(0,end));
"
```

Then re-apply the three changes above and diff against the new upstream to see what else moved.

**Traps, learned the hard way:**

* The template is **CRLF**. Matching it with `\n`-joined strings silently fails, and `sed` hides
  the difference — use `od -c` to check. Emit CRLF so the fork's diff stays one reviewable hunk
  rather than 977 line-ending changes.
* Preserve every Handlebars render point. Besides the obvious `{{#each resources}}`, there is
  `{{#each resources_dirs}}`, `{{#each resources_ancestors}}`, `{{#if installer_hooks}}` and —
  easily missed because it sits outside every loop — `!define ESTIMATEDSIZE "{{estimated_size}}"`,
  which feeds the Add/Remove Programs size column. Dropping it is a compile error in both builds.
* All four `NSIS_HOOK_*` insertion points must survive, or `hooks.nsh` silently stops running —
  including the stale-engine removal, which prevents an upgraded app binding a ~580 MB orphaned
  engine.
* `bundle.windows.nsis` is set in `tauri.windows.conf.json`, and `tauri.bundled.conf.json` only
  overlays `bundle.resources` — so this template applies to **both** the web and bundled installers
  automatically. Smoke-test the ~330 MB bundled build too, not just the fast one.

## What cannot be fixed here

An animated or gradient progress bar is not reachable from NSIS at all. `PBM_SETBARCOLOR` is ignored
while visual styles are enabled, and disabling them yields the Windows 2000 bar; owner-drawing needs
a window procedure, and the System plugin is single-threaded — its callbacks fire only while the
script is inside another call, so there is no `WM_PAINT`, no `WM_DRAWITEM` and no timer.

Relatedly: on the bundled build the bar sits near 4% while ~297 MB decompresses, because NSIS
advances the bar once per *instruction* and the engine is one `File` instruction out of 574. Neither
is a styling problem; both need a bespoke installer binary.
