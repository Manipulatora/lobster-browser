<#
.SYNOPSIS
  Package a runnable Lobium Windows runtime from the Chromium out/ directory.

.DESCRIPTION
  The Windows counterpart of scripts/package-lobium-runtime.sh. Not a port of it: the two platforms
  ship genuinely different file sets, and copying the Linux list would produce a runtime that does
  not start.

    * chrome.exe on Windows is a ~4 MB launcher stub; essentially the whole browser lives in
      chrome.dll (~280 MB). Shipping the exe alone yields a binary that exits immediately.
    * chrome_elf.dll must sit beside chrome.exe. It is loaded before anything else to install the
      crash handler and blocklist, and Windows resolves it by directory, not by PATH.
    * There are no .so files and no chrome_sandbox helper; the Windows sandbox is in-process.
    * d3dcompiler_47.dll and the two SwiftShader DLLs are what make WebGL work. Their absence does
      not fail loudly - getContext('webgl') simply returns null, which renders WebGL sites blank and
      is itself a strong headless signal.

  The font pack is provisioned the same way as on Linux (same script, same licensed faces), but it is
  consumed differently: Linux points FONTCONFIG_FILE at it, while on Windows the engine sideloads the
  faces into its DirectWrite collection from the fontPackDir in the profile config. Both routes need
  the pack physically present, so it is packaged identically.

.PARAMETER OutDir
  Destination. Defaults to <repo>/dist-win/lobium-runtime.

.PARAMETER SourceDir
  The Chromium output directory. Defaults to $env:LOBSTER_LOBIUM_DIR, then the known build locations.

.PARAMETER FontPack
  A directory containing an already-provisioned font pack (with font-pack.manifest.json), copied into
  the runtime as-is.

  This is a parameter rather than something the script builds, because it cannot build it here:
  scripts/provision-open-fonts.mjs verifies every face's real family name with `fc-scan`, and
  fontconfig does not exist on Windows. Verification is the point of that script — it refuses to
  claim a family it cannot confirm is physically present — so skipping the check and copying files
  blind would produce a pack that lies about what it contains. Provision it on a host with
  fontconfig and pass the directory here.

  Omitted, the runtime is packaged WITHOUT a pack. That is a supported, degraded state: the engine's
  native filter still runs, so the measurable font set is host-intersect-persona — narrower than the
  persona claims, never wider than the host. The marker file records the absence so the launcher and
  any later audit can see it rather than inferring isolation that is only half present.

.EXAMPLE
  ./scripts/package-lobium-runtime.ps1
.EXAMPLE
  ./scripts/package-lobium-runtime.ps1 -FontPack D:\packs\lobium-fonts
#>
[CmdletBinding()]
param(
  [string]$OutDir,
  [string]$SourceDir,
  [string]$FontPack
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# ---------------------------------------------------------------------------------------------
# Locate the build output
# ---------------------------------------------------------------------------------------------
$configuredOut = if ($env:LOBIUM_CHROMIUM_SRC) {
  Join-Path $env:LOBIUM_CHROMIUM_SRC 'out'
}
$candidates = @(
  $SourceDir,
  $env:LOBSTER_LOBIUM_DIR,
  $env:LOBSTER_LOBIUM_SRC,
  $(if ($configuredOut) { Join-Path $configuredOut 'Lobium' }),
  $(if ($configuredOut) { Join-Path $configuredOut 'LobiumOfficial' }),
  (Join-Path $env:USERPROFILE 'lobium-build\src\out\Lobium')
) | Where-Object { $_ }

$src = $candidates | Where-Object { Test-Path (Join-Path $_ 'chrome.exe') } | Select-Object -First 1
if (-not $src) {
  throw "Lobium chrome.exe not found. Set -SourceDir or LOBSTER_LOBIUM_DIR to the out/Lobium directory."
}
if (-not $OutDir) { $OutDir = Join-Path $root 'dist-win\lobium-runtime' }

Write-Output "[lobium-runtime] source: $src"
Write-Output "[lobium-runtime] target: $OutDir"

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Copy-Required {
  param([string[]]$Names)
  foreach ($name in $Names) {
    $path = Join-Path $src $name
    if (-not (Test-Path $path)) {
      # Hard failure, not a warning. Every name in this list is load-bearing: a runtime missing one
      # of them either does not start or silently loses a capability (WebGL, crash reporting) in a
      # way that is observable to a detector but invisible to whoever packaged it.
      throw "required runtime file is missing from the build output: $name"
    }
    Copy-Item $path (Join-Path $OutDir $name) -Force
  }
}

function Copy-Optional {
  param([string[]]$Names)
  foreach ($name in $Names) {
    foreach ($item in @(Get-ChildItem -Path $src -Filter $name -File -ErrorAction SilentlyContinue)) {
      Copy-Item $item.FullName (Join-Path $OutDir $item.Name) -Force
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Core binaries
# ---------------------------------------------------------------------------------------------
Copy-Required @(
  'chrome.exe',
  # The browser itself. chrome.exe is only a stub that loads this.
  'chrome.dll',
  # Loaded before CRT init to install crash handling and the DLL blocklist. Resolved from the
  # executable's own directory, so it cannot be left to a system copy.
  'chrome_elf.dll',
  # ANGLE's D3D11 backend compiles every shader through this. Without it WebGL context creation
  # fails and getContext('webgl') returns null.
  'd3dcompiler_47.dll',
  'libEGL.dll',
  'libGLESv2.dll',
  # ICU data: timezone rules, collation, locale data. The persona timezone hook resolves IANA ids
  # through ICU, so a missing icudtl.dat breaks the timezone spoof as well as text rendering.
  'icudtl.dat',
  'v8_context_snapshot.bin',
  'resources.pak',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  # The Visual C++ runtime. chrome.exe links it dynamically, so without these the process cannot
  # start at all - and the error Windows gives ("side-by-side configuration is incorrect") names
  # neither the missing DLL nor the manifest, which is why this list is checked rather than assumed.
  'msvcp140.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll'
)

# The versioned side-by-side assembly manifest (e.g. "152.0.7977.42.manifest"). chrome.exe's embedded
# manifest declares a dependency on this assembly; if it is absent the loader fails with the
# side-by-side error above before any Chromium code runs. Named after the build, so matched by glob.
$sxs = @(Get-ChildItem -Path $src -Filter '*.manifest' -File -ErrorAction SilentlyContinue)
if (-not $sxs) {
  throw 'no *.manifest found in the build output; chrome.exe cannot resolve its side-by-side assembly without it'
}
foreach ($m in $sxs) { Copy-Item $m.FullName (Join-Path $OutDir $m.Name) -Force }

# ---------------------------------------------------------------------------------------------
# Optional-but-expected
# ---------------------------------------------------------------------------------------------
Copy-Optional @(
  'chrome_crashpad_handler.exe',
  # Present only on some toolchain versions; harmless when absent, and a missing one that IS needed
  # would already have failed the required list above.
  'msvcp140_atomic_wait.dll',
  'vccorlib140.dll',
  'chrome_wer.dll',
  'eventlog_provider.dll',
  # Software rasterisation fallback. Required on hosts with no usable GPU; on a real-GPU host it is
  # never loaded, so packaging it costs disk and nothing else.
  'vk_swiftshader.dll',
  'vulkan-1.dll',
  '*_icd.json',
  'snapshot_blob.bin',
  '*.pak',
  'product_logo_*.png',
  'notification_helper.exe',
  'elevation_service.exe'
)

# ---------------------------------------------------------------------------------------------
# Directories
# ---------------------------------------------------------------------------------------------
foreach ($dir in @('locales', 'resources', 'angledata', 'MEIPreload',
                   'PrivacySandboxAttestationsPreloaded', 'IwaKeyDistribution', 'WidevineCdm')) {
  $path = Join-Path $src $dir
  if (Test-Path $path) {
    Copy-Item $path (Join-Path $OutDir $dir) -Recurse -Force
  }
}
if (-not (Test-Path (Join-Path $OutDir 'locales\en-US.pak'))) {
  # Chromium resolves every UI string through the locale paks. Without them the browser starts but
  # renders an untranslated shell, and the mismatch between the persona's Accept-Language and the
  # available locales is observable.
  throw 'locales/en-US.pak is missing; the build output looks incomplete'
}

# ---------------------------------------------------------------------------------------------
# Font pack
# ---------------------------------------------------------------------------------------------
# The engine sideloads these into its DirectWrite collection (config `fontPackDir`) rather than
# reading them through fontconfig, so the persona can advertise families this host never had
# installed - filtering alone can only subtract.
#
# The pack rides with the ENGINE, not the installer: it lands in fonts/ beside chrome.exe, which is
# the first location resolveFontsBaseDir() checks. The pack and the engine that consumes it then
# travel together and cannot get out of step.
$fontsOut = Join-Path $OutDir 'fonts'
$fontsProvisioned = $false

if ($FontPack) {
  $manifest = Join-Path $FontPack 'font-pack.manifest.json'
  if (-not (Test-Path $manifest)) {
    throw "-FontPack '$FontPack' has no font-pack.manifest.json; that manifest is what records which families the pack can actually back"
  }
  Copy-Item $FontPack $fontsOut -Recurse -Force
  $faces = @(Get-ChildItem $fontsOut -File -Include *.ttf, *.ttc, *.otf, *.otc -Recurse).Count
  Write-Output "[lobium-runtime] font pack: $faces faces from $FontPack"
  $fontsProvisioned = $true
} else {
  Write-Warning @'
No font pack provisioned (-FontPack not given).

  The runtime is still usable and still font-isolated in the SUBTRACTIVE direction: the engine
  filters font lookups against the persona list, so no host font outside that list is measurable.
  What is missing is the additive half - families the persona claims but this host lacks will not
  resolve, so the profile measures as a machine with fewer fonts than it says it has.

  scripts/provision-open-fonts.mjs cannot run here: it verifies each face's real family with
  fc-scan, and fontconfig does not exist on Windows. Provision the pack on a host that has it and
  re-run with -FontPack <dir>.
'@
}

# ---------------------------------------------------------------------------------------------
# Marker consumed by resolveLobiumBinary / resolveFontsBaseDir
# ---------------------------------------------------------------------------------------------
$version = (Get-Item (Join-Path $OutDir 'chrome.exe')).VersionInfo.ProductVersion
[ordered]@{
  engine   = 'lobium'
  platform = 'win-x64'
  chrome   = 'chrome.exe'
  # null, not a path, when no pack was provisioned. An audit reading this file must be able to see
  # that the additive half of font isolation is absent rather than infer it from a missing directory.
  fonts      = $(if ($fontsProvisioned) { 'fonts/font-pack.manifest.json' } else { $null })
  version    = $version
  packagedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
} | ConvertTo-Json | Out-File -FilePath (Join-Path $OutDir 'LOBSTER_ENGINE.json') -Encoding utf8

# ---------------------------------------------------------------------------------------------
# Prove the packaged binary is the patched engine, not a stock Chromium that happened to be lying
# around. The capability probe is the same one the sidecar runs before every launch, so a runtime
# that fails here would have failed at launch anyway - better to find out at packaging time.
# ---------------------------------------------------------------------------------------------
# Redirected through cmd rather than captured with `&`. chrome.exe is a WINDOWS-subsystem binary, so
# PowerShell's operator does not receive its stdout and silently yields nothing - which would make a
# perfectly good runtime fail this check. The sidecar has no such problem: it spawns with piped stdio
# via execFile, which the process inherits normally.
$probeOut = Join-Path ([System.IO.Path]::GetTempPath()) "lobium-caps-$PID.json"
cmd /c "`"$(Join-Path $OutDir 'chrome.exe')`" --lobium-fingerprint-capabilities > `"$probeOut`" 2>nul"
$manifest = if (Test-Path $probeOut) { (Get-Content $probeOut -Raw).Trim() } else { '' }
Remove-Item $probeOut -Force -ErrorAction SilentlyContinue
if (-not $manifest) {
  throw 'packaged chrome.exe did not emit a capability manifest; this is not a Lobium build'
}
$capabilityManifest = $manifest | ConvertFrom-Json
$expectedContractVersion = 2
if ($capabilityManifest.product -ne 'Lobium' -or
    $capabilityManifest.contractVersion -ne $expectedContractVersion) {
  throw "packaged engine has an incompatible capability contract (expected Lobium v$expectedContractVersion)"
}
$caps = $capabilityManifest.capabilities
foreach ($required in @('config-channel-v1', 'webgl-deep', 'webgl2-deep', 'font-isolation',
                        'native-timezone', 'webgpu-adapter', 'media-devices', 'screen-metrics')) {
  if ($caps -notcontains $required) {
    throw "packaged engine is missing the '$required' native hook"
  }
}

$size = '{0:N1} GB' -f ((Get-ChildItem $OutDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1GB)
Write-Output "[lobium-runtime] capabilities: $($caps.Count) hooks, version $version"
Write-Output "[lobium-runtime] done -> $OutDir ($size)"
