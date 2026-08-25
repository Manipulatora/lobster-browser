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

  Packaging is transactional. Source paths, required files, the exact Lobium version and the complete
  native capability contract are validated before an existing destination is touched. Files are copied
  to a sibling staging directory, hashed into LOBSTER_ENGINE.json, independently verified, and only then
  swapped into place; a failed rename restores the previous output.

.PARAMETER OutDir
  Destination. Defaults to <repo>/dist-win/lobium-runtime.

.PARAMETER SourceDir
  The Chromium output directory. Defaults to $env:LOBSTER_LOBIUM_DIR, then the known build locations.

.PARAMETER FontPack
  A directory containing an already-provisioned font pack (with font-pack.manifest.json), copied into
  the runtime as-is. Supplying this parameter also requires -FontScanner.

  This is a parameter rather than something the script builds. scripts/provision-open-fonts.mjs
  verifies every face's complete family inventory with fc-scan. This packager independently repeats
  that exact scan before and after copying the pack, then records the family-inventory digest and
  scanner provenance in LOBSTER_ENGINE.json.

  Omitted, the runtime is packaged WITHOUT a pack. That is a supported, degraded state: the engine's
  native filter still runs, so the measurable font set is host-intersect-persona — narrower than the
  persona claims, never wider than the host. The marker file records the absence so the launcher and
  any later audit can see it rather than inferring isolation that is only half present.

.PARAMETER FontScanner
  Explicit path to an fc-scan executable. Mandatory with -FontPack. It is invoked directly (never
  through a shell), must be an ordinary non-reparse file, and its version and SHA-256 are recorded in
  the runtime marker. On this build host the reviewed scanner is
  C:\project\tools\msys64\mingw64\bin\fc-scan.exe.

.EXAMPLE
  ./scripts/package-lobium-runtime.ps1
.EXAMPLE
  ./scripts/package-lobium-runtime.ps1 -FontPack D:\packs\lobium-fonts `
    -FontScanner C:\tools\msys64\mingw64\bin\fc-scan.exe
#>
[CmdletBinding()]
param(
  [string]$OutDir,
  [string]$SourceDir,
  [string]$FontPack,
  [string]$FontScanner
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$markerName = 'LOBSTER_ENGINE.json'
$artifactAlgorithm = 'sha256-path-size-content-v1'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$runtimeVerifier = Join-Path $root 'scripts\verify-lobium-runtime.mjs'
if (-not (Test-Path -LiteralPath $runtimeVerifier -PathType Leaf)) {
  throw "independent runtime verifier is missing: '$runtimeVerifier'"
}
if ($FontPack -and -not $FontScanner) {
  throw '-FontScanner <fc-scan executable> is mandatory when -FontPack is supplied'
}
if ($FontScanner -and -not $FontPack) {
  throw '-FontScanner is only valid together with -FontPack'
}

function Resolve-CanonicalPath {
  param([string]$Path, [switch]$MustExist)
  $providerPath = if ($MustExist) {
    (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath
  } else {
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  }
  $full = [System.IO.Path]::GetFullPath($providerPath)
  if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
  return $full
}

function Test-PathContains {
  param([string]$Parent, [string]$Candidate)
  if ($Parent.Equals($Candidate, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  $prefix = $Parent.TrimEnd('\') + '\'
  return $Candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePathComponents {
  param([string]$Path, [string]$Label)
  # GetFullPath resolves dot segments but deliberately does not dereference junctions/symlinks. Reject
  # every existing component so a not-yet-created OutDir cannot hide inside SourceDir through a
  # reparse-point parent after the textual overlap check has passed.
  $cursor = $Path
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $attributes = (Get-Item -LiteralPath $cursor -Force).Attributes
      if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "refusing $Label path with reparse-point component '$cursor'"
      }
    }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent.Equals($cursor, [System.StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $cursor = $parent
  }
}

function Assert-FontPack {
  param([string]$Path, [string]$Verifier, [string]$Scanner)
  if (-not (Test-Path -LiteralPath (Join-Path $Path 'font-pack.manifest.json') -PathType Leaf)) {
    throw "-FontPack '$Path' has no font-pack.manifest.json"
  }
  # This is the same independent scanner-backed verifier used after the runtime copy. Running it
  # before staging protects an existing package from a malformed source pack; running it again on
  # fonts/ below detects an incomplete/transformed copy or a family declaration that does not match
  # the physical font bytes.
  $savedErrorPreference = $ErrorActionPreference
  try {
    # PowerShell 5.1 promotes a native process's stderr to ErrorRecord. Temporarily keep that output
    # non-terminating so the explicit exit-code branch below can preserve the verifier's diagnosis.
    $ErrorActionPreference = 'Continue'
    $verificationOutput = @(& node $Verifier --font-pack $Path --font-scanner $Scanner --json 2>&1)
    $verificationExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorPreference
  }
  if ($verificationExit -ne 0) {
    $detail = @($verificationOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    throw "font pack verification failed for '$Path' (exit $verificationExit)$(if ($detail) { ": $detail" })"
  }
  $json = @($verificationOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
  try { $result = $json | ConvertFrom-Json }
  catch { throw "font pack verifier returned invalid attestation JSON for '$Path': $($_.Exception.Message)" }
  if ($result.kind -ne 'font-pack' -or -not $result.packId -or -not $result.fontInventory) {
    throw "font pack verifier returned an incomplete attestation for '$Path'"
  }
  return $result
}

function Read-ProbeStream {
  param([string]$Path)
  # Get-Content -Raw yields $null - not an empty string - for a zero-byte file, so calling .Trim()
  # on it directly throws. cmd redirection creates both streams whether or not the child writes
  # to them, so Test-Path is not the guard it looks like. An empty stderr is the NORMAL case for
  # a clean probe: this failed exactly when the engine behaved correctly, and survived only when
  # Crashpad happened to emit transient noise.
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
  if ($null -eq $raw) { return '' }
  return $raw.Trim()
}

function Invoke-BrowserProbe {
  param([string]$Chrome, [string]$Argument, [string]$Label)
  $token = "$PID-$([Guid]::NewGuid().ToString('N'))"
  $stdout = Join-Path ([System.IO.Path]::GetTempPath()) "lobium-$Label-$token.out"
  $stderr = Join-Path ([System.IO.Path]::GetTempPath()) "lobium-$Label-$token.err"
  try {
    # chrome.exe is a WINDOWS-subsystem binary. PowerShell 5.1 does not reliably capture its stdout,
    # while cmd redirection is inherited by the child and does. The argument is a fixed string owned
    # by this script; no caller-controlled command fragment is interpolated here.
    cmd /d /c "`"$Chrome`" $Argument > `"$stdout`" 2> `"$stderr`""
    $exit = $LASTEXITCODE
    $value = Read-ProbeStream $stdout
    $errorText = Read-ProbeStream $stderr
    if ($exit -ne 0 -or -not $value) {
      throw "$Label probe failed for '$Chrome' (exit $exit)$(if ($errorText) { ": $errorText" })"
    }
    return $value
  } finally {
    Remove-Item -LiteralPath $stdout -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderr -Force -ErrorAction SilentlyContinue
  }
}

function Read-PeProductVersion {
  param([string]$Chrome)
  try {
    $file = Get-Item -LiteralPath $Chrome -ErrorAction Stop
    $version = [string]$file.VersionInfo.ProductVersion
  } catch {
    throw "cannot read PE VERSIONINFO from '$Chrome': $($_.Exception.Message)"
  }
  if ($version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    throw "'$Chrome' has invalid PE ProductVersion '$version'"
  }
  return $version
}

function Read-CapabilityManifest {
  param([string]$Chrome)
  $raw = Invoke-BrowserProbe $Chrome '--lobium-fingerprint-capabilities' 'capabilities'
  try { return $raw | ConvertFrom-Json }
  catch { throw "capability probe returned invalid JSON for '$Chrome': $($_.Exception.Message)" }
}

function Assert-CapabilityManifest {
  param($Manifest, [string]$Chrome)
  $expectedContractVersion = 3
  if ($Manifest.product -ne 'Lobium' -or
      $Manifest.contractVersion -ne $expectedContractVersion) {
    throw "'$Chrome' has an incompatible capability contract (expected Lobium v$expectedContractVersion)"
  }
  # Keep the complete list synchronized with lobium/src/lobium_capabilities.cc. Checking a small
  # subset let a binary package successfully and then fail at first profile launch on an omitted hook.
  $requiredCapabilities = @(
    'config-channel-v1',
    'navigator-ua-ch',
    'navigator-webdriver',
    'navigator-languages',
    'network-accept-language',
    'process-locale-timezone',
    'native-geolocation',
    'webrtc-policy',
    'webgl-deep',
    'webgl2-deep',
    'screen-metrics',
    'mobile-persona',
    'canvas-farbling',
    'webgl-farbling',
    'audio-farbling',
    'client-rects',
    'media-devices',
    'webgpu-adapter',
    'native-timezone',
    'font-isolation'
  )
  $actual = @($Manifest.capabilities)
  foreach ($required in $requiredCapabilities) {
    if ($actual -notcontains $required) {
      throw "'$Chrome' is missing the '$required' native hook"
    }
  }
  if ($actual.Count -ne $requiredCapabilities.Count) {
    $unexpected = @($actual | Where-Object { $requiredCapabilities -notcontains $_ })
    throw "'$Chrome' emitted an unexpected capability set: $($unexpected -join ', ')"
  }
  return $requiredCapabilities
}

function Get-ArtifactLedger {
  param([string]$RuntimeDir)
  [string[]]$paths = @(Get-ChildItem -LiteralPath $RuntimeDir -Recurse -File -Force -Name | ForEach-Object {
    $_.Replace('\', '/')
  } | Where-Object { $_ -cne $markerName })
  [Array]::Sort($paths, [System.StringComparer]::Ordinal)
  $files = @()
  $lines = New-Object System.Text.StringBuilder
  foreach ($relative in $paths) {
    if ($relative -match '(^|/)\.\.?(/|$)' -or
        $relative -match '^[A-Za-z]:' -or
        $relative -match '[\x00-\x1f<>:"|?*]' -or
        @($relative -split '/' | Where-Object { $_ -match '[. ]$' }).Count -gt 0) {
      throw "unsafe packaged artifact path '$relative'"
    }
    $absolute = Join-Path $RuntimeDir ($relative.Replace('/', '\'))
    $item = Get-Item -LiteralPath $absolute
    $sha256 = (Get-FileHash -LiteralPath $absolute -Algorithm SHA256).Hash.ToLowerInvariant()
    $entry = [ordered]@{ path = $relative; bytes = [Int64]$item.Length; sha256 = $sha256 }
    $files += $entry
    [void]$lines.Append($relative).Append("`t").Append($item.Length).Append("`t").Append($sha256).Append("`n")
  }
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try { $tree = ([BitConverter]::ToString($hasher.ComputeHash($utf8NoBom.GetBytes($lines.ToString())))).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
  return [ordered]@{ algorithm = $artifactAlgorithm; treeSha256 = $tree; files = $files }
}

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

$src = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'chrome.exe') } | Select-Object -First 1
if (-not $src) {
  throw "Lobium chrome.exe not found. Set -SourceDir or LOBSTER_LOBIUM_DIR to the out/Lobium directory."
}
if (-not $OutDir) { $OutDir = Join-Path $root 'dist-win\lobium-runtime' }
$src = Resolve-CanonicalPath $src -MustExist
$OutDir = Resolve-CanonicalPath $OutDir
$repoRoot = Resolve-CanonicalPath $root -MustExist
Assert-NoReparsePathComponents $src 'source'
Assert-NoReparsePathComponents $OutDir 'output'

# OutDir is recursively replaced below. Resolve both sides first and reject every overlap direction,
# including OutDir being a parent of SourceDir. The old script accepted -OutDir $SourceDir and erased
# the completed Chromium build before discovering that its first required file was gone.
if ((Test-PathContains $src $OutDir) -or (Test-PathContains $OutDir $src)) {
  throw "refusing overlapping Lobium package paths: source '$src', output '$OutDir'"
}
$outParent = Split-Path -Parent $OutDir
$outLeaf = Split-Path -Leaf $OutDir
$repoDist = Resolve-CanonicalPath (Join-Path $repoRoot 'dist-win')
if (-not $outParent -or
    $OutDir -eq [System.IO.Path]::GetPathRoot($OutDir) -or
    (Test-PathContains $OutDir $repoRoot) -or
    ((Test-PathContains $repoRoot $OutDir) -and -not (Test-PathContains $repoDist $OutDir)) -or
    $outLeaf -notmatch '^(lobium|lobium-runtime(?:[-._][A-Za-z0-9.-]*[A-Za-z0-9])?)$') {
  throw "refusing unsafe Lobium package output '$OutDir'"
}

Write-Output "[lobium-runtime] source: $src"
Write-Output "[lobium-runtime] target: $OutDir"

$sourceFontAttestation = $null
if ($FontPack) {
  $FontPack = Resolve-CanonicalPath $FontPack -MustExist
  $FontScanner = Resolve-CanonicalPath $FontScanner -MustExist
  Assert-NoReparsePathComponents $FontPack 'font pack'
  Assert-NoReparsePathComponents $FontScanner 'font scanner'
  if (-not (Test-Path -LiteralPath $FontScanner -PathType Leaf)) {
    throw "-FontScanner '$FontScanner' is not an ordinary executable file"
  }
  if ((Test-PathContains $FontPack $OutDir) -or (Test-PathContains $OutDir $FontPack)) {
    throw "refusing overlapping font-pack/output paths: font pack '$FontPack', output '$OutDir'"
  }
  if (Test-PathContains $OutDir $FontScanner) {
    throw "refusing font scanner inside destructive package output '$OutDir': '$FontScanner'"
  }
  $sourceFontAttestation = Assert-FontPack $FontPack $runtimeVerifier $FontScanner
  Write-Output "[lobium-runtime] scanned source font pack: $($sourceFontAttestation.packId)"
}

$requiredFiles = @(
  'chrome.exe', 'chrome.dll', 'chrome_elf.dll', 'd3dcompiler_47.dll', 'libEGL.dll',
  'libGLESv2.dll', 'icudtl.dat', 'v8_context_snapshot.bin', 'resources.pak',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'msvcp140.dll', 'vcruntime140.dll',
  'vcruntime140_1.dll', 'args.gn'
)

# Preflight every invariant that can be checked against the build output BEFORE creating staging or
# moving/replacing an existing package. A bad source leaves the old OutDir byte-for-byte untouched.
foreach ($name in $requiredFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $src $name) -PathType Leaf)) {
    throw "required runtime/build file is missing from the source: $name"
  }
}
$sxs = @(Get-ChildItem -LiteralPath $src -Filter '*.manifest' -File -ErrorAction SilentlyContinue)
if (-not $sxs) {
  throw 'no *.manifest found in the build output; chrome.exe cannot resolve its side-by-side assembly without it'
}
if (-not (Test-Path -LiteralPath (Join-Path $src 'locales\en-US.pak') -PathType Leaf)) {
  throw 'source locales/en-US.pak is missing; the build output is incomplete'
}
$sourceChrome = Join-Path $src 'chrome.exe'
$version = Read-PeProductVersion $sourceChrome
if (-not (Test-Path -LiteralPath (Join-Path $src "$version.manifest") -PathType Leaf)) {
  throw "source is missing its exact side-by-side assembly manifest: $version.manifest"
}
$pinnedMatch = Select-String -LiteralPath (Join-Path $root 'lobium\build.ps1') -Pattern "\`$ChromiumRef = '([0-9.]+)'" | Select-Object -First 1
if (-not $pinnedMatch -or $pinnedMatch.Matches[0].Groups[1].Value -ne $version) {
  throw "source engine version '$version' does not match lobium/build.ps1's pinned ChromiumRef"
}
$sourceCapabilities = Read-CapabilityManifest $sourceChrome
$requiredCapabilities = Assert-CapabilityManifest $sourceCapabilities $sourceChrome

$chromiumCheckout = Split-Path -Parent $src
while ($chromiumCheckout -and -not (Test-Path -LiteralPath (Join-Path $chromiumCheckout '.gn') -PathType Leaf)) {
  $parent = Split-Path -Parent $chromiumCheckout
  if (-not $parent -or $parent -eq $chromiumCheckout) { $chromiumCheckout = $null; break }
  $chromiumCheckout = $parent
}
if (-not $chromiumCheckout) {
  throw "cannot locate the Chromium checkout above '$src'; refusing untraceable build output"
}
$chromiumRef = (& git -C $chromiumCheckout describe --tags --exact-match HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $chromiumRef) {
  throw "Chromium checkout '$chromiumCheckout' is not at an exact tag"
}
$chromiumRef = $chromiumRef.Trim()
if ($chromiumRef -ne $version) {
  throw "Chromium checkout is at '$chromiumRef', but chrome.exe reports '$version'"
}
$chromiumCommitRaw = & git -C $chromiumCheckout rev-parse HEAD 2>$null
if ($LASTEXITCODE -ne 0 -or -not $chromiumCommitRaw) {
  throw "cannot resolve Chromium commit for '$chromiumCheckout'"
}
$chromiumCommit = $chromiumCommitRaw.Trim()
if ($chromiumCommit -notmatch '^[0-9a-f]{40}$') { throw "invalid Chromium commit '$chromiumCommit'" }
$lobsterRevisionRaw = & git -C $root rev-parse HEAD 2>$null
if ($LASTEXITCODE -ne 0 -or -not $lobsterRevisionRaw) {
  throw "cannot resolve Lobster source revision for '$root'"
}
$lobsterRevision = $lobsterRevisionRaw.Trim()
if ($lobsterRevision -notmatch '^[0-9a-f]{40}$') { throw "invalid Lobster revision '$lobsterRevision'" }
$lobsterDirty = [bool](& git -C $root status --porcelain --untracked-files=no)
$buildArgsSha256 = (Get-FileHash -LiteralPath (Join-Path $src 'args.gn') -Algorithm SHA256).Hash.ToLowerInvariant()

function Copy-Required {
  param([string[]]$Names, [string]$Destination)
  foreach ($name in $Names) {
    $path = Join-Path $src $name
    Copy-Item -LiteralPath $path -Destination (Join-Path $Destination $name) -Force
  }
}

function Copy-Optional {
  param([string[]]$Names, [string]$Destination)
  foreach ($name in $Names) {
    foreach ($item in @(Get-ChildItem -LiteralPath $src -Filter $name -File -ErrorAction SilentlyContinue)) {
      Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $Destination $item.Name) -Force
    }
  }
}

$token = "$PID-$([Guid]::NewGuid().ToString('N'))"
$staging = Join-Path $outParent ".$outLeaf.incoming-$token"
$backup = "$OutDir.previous"
if (Test-Path -LiteralPath $backup) {
  throw "previous package backup still exists at '$backup'; inspect/recover it before packaging again"
}
New-Item -ItemType Directory -Force -Path $outParent | Out-Null
New-Item -ItemType Directory -Path $staging | Out-Null

try {

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
) $staging

# The versioned side-by-side assembly manifest (e.g. "152.0.7977.42.manifest"). chrome.exe's embedded
# manifest declares a dependency on this assembly; if it is absent the loader fails with the
# side-by-side error above before any Chromium code runs. Named after the build, so matched by glob.
foreach ($m in $sxs) {
  Copy-Item -LiteralPath $m.FullName -Destination (Join-Path $staging $m.Name) -Force
}

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
) $staging

# ---------------------------------------------------------------------------------------------
# Directories
# ---------------------------------------------------------------------------------------------
foreach ($dir in @('locales', 'resources', 'angledata', 'MEIPreload',
                   'PrivacySandboxAttestationsPreloaded', 'IwaKeyDistribution', 'WidevineCdm')) {
  $path = Join-Path $src $dir
  if (Test-Path -LiteralPath $path) {
    Copy-Item -LiteralPath $path -Destination (Join-Path $staging $dir) -Recurse -Force
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $staging 'locales\en-US.pak'))) {
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
$fontsOut = Join-Path $staging 'fonts'
$fontsProvisioned = $false

if ($FontPack) {
  Copy-Item -LiteralPath $FontPack -Destination $fontsOut -Recurse -Force
  $stagedFontAttestation = Assert-FontPack $fontsOut $runtimeVerifier $FontScanner
  if ($stagedFontAttestation.fontInventory.algorithm -cne $sourceFontAttestation.fontInventory.algorithm -or
      $stagedFontAttestation.fontInventory.sha256 -cne $sourceFontAttestation.fontInventory.sha256 -or
      $stagedFontAttestation.fontInventory.scanner.product -cne $sourceFontAttestation.fontInventory.scanner.product -or
      $stagedFontAttestation.fontInventory.scanner.version -cne $sourceFontAttestation.fontInventory.scanner.version -or
      $stagedFontAttestation.fontInventory.scanner.executableSha256 -cne $sourceFontAttestation.fontInventory.scanner.executableSha256) {
    throw 'staged font-family attestation differs from the scanned source pack'
  }
  $faces = @(Get-ChildItem -LiteralPath $fontsOut -File -Include *.ttf, *.ttc, *.otf -Recurse).Count
  if ($faces -le 0) { throw "verified font pack '$FontPack' copied no loadable font faces" }
  Write-Output "[lobium-runtime] font pack: $faces faces from $FontPack"
  $fontsProvisioned = $true
} else {
  $stagedFontAttestation = $null
  Write-Warning @'
No font pack provisioned (-FontPack not given).

  The runtime is still usable and still font-isolated in the SUBTRACTIVE direction: the engine
  filters font lookups against the persona list, so no host font outside that list is measurable.
  What is missing is the additive half - families the persona claims but this host lacks will not
  resolve, so the profile measures as a machine with fewer fonts than it says it has.

  Provision the pack with scripts/provision-open-fonts.mjs on a host that has fontconfig, then
  re-run with -FontPack <dir> -FontScanner <fc-scan executable>. The packager repeats the exact
  family scan and will not accept a manifest whose claims differ from the font bytes.
'@
}

# ---------------------------------------------------------------------------------------------
# Marker consumed by resolveLobiumBinary / resolveFontsBaseDir and independently verified by
# scripts/verify-lobium-runtime.mjs. The marker cannot hash itself, so the artifact ledger covers every
# other file. The published archive SHA-256 in engine-manifest.json then covers the marker as well.
# ---------------------------------------------------------------------------------------------
$artifactLedger = Get-ArtifactLedger $staging
$marker = [ordered]@{
  schemaVersion = 2
  engine        = 'lobium'
  platform      = 'win-x64'
  chrome        = 'chrome.exe'
  # null, not a path, when no pack was provisioned. An audit reading this file must be able to see
  # that the additive half of font isolation is absent rather than infer it from a missing directory.
  fonts         = $(if ($fontsProvisioned) { 'fonts/font-pack.manifest.json' } else { $null })
  # This is a packaging attestation, not a signature: the external archive SHA-256 remains the trust
  # anchor. It lets an extracted runtime prove its manifest still carries the exact family inventory
  # that fc-scan checked during packaging, even on a consumer host without fontconfig installed.
  fontInventory = $(if ($fontsProvisioned) { $stagedFontAttestation.fontInventory } else { $null })
  version       = $version
  packagedAt    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  provenance = [ordered]@{
    # These values are observed independently from the executable, checkout and GN output. They are
    # provenance, not a signature; the externally distributed archive SHA-256 is the trust anchor.
    chromiumRef              = $chromiumRef
    chromiumCommit           = $chromiumCommit
    lobsterRevision          = $lobsterRevision
    lobsterWorkingTreeDirty  = $lobsterDirty
    buildArgsSha256           = $buildArgsSha256
    capabilityContractVersion = [int]$sourceCapabilities.contractVersion
    capabilities              = @($sourceCapabilities.capabilities)
  }
  artifacts = $artifactLedger
}
$markerJson = $marker | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText((Join-Path $staging $markerName), "$markerJson`r`n", $utf8NoBom)

# ---------------------------------------------------------------------------------------------
# Prove the packaged binary is the patched engine, not a stock Chromium that happened to be lying
# around. The capability probe is the same one the sidecar runs before every launch, so a runtime
# that fails here would have failed at launch anyway - better to find out at packaging time.
# ---------------------------------------------------------------------------------------------
$stagedChrome = Join-Path $staging 'chrome.exe'
$stagedVersion = Read-PeProductVersion $stagedChrome
if ($stagedVersion -ne $version) {
  throw "staged engine has ProductVersion '$stagedVersion', expected '$version'"
}
$stagedCapabilities = Read-CapabilityManifest $stagedChrome
[void](Assert-CapabilityManifest $stagedCapabilities $stagedChrome)

# Verify the PowerShell-produced ledger with an independent implementation before it can replace an
# existing output. This detects copy truncation, extra files and PowerShell/Node canonicalization drift.
if ($fontsProvisioned) {
  & node $runtimeVerifier $staging --font-scanner $FontScanner
} else {
  & node $runtimeVerifier $staging
}
if ($LASTEXITCODE -ne 0) { throw "independent runtime artifact verification failed (exit $LASTEXITCODE)" }

# Transactional same-parent swap. A source/copy/probe/ledger failure above leaves OutDir untouched.
# If the final rename fails after moving the old package aside, restore it before returning the error.
$previousMoved = $false
try {
  if (Test-Path -LiteralPath $OutDir) {
    Move-Item -LiteralPath $OutDir -Destination $backup
    $previousMoved = $true
  }
  Move-Item -LiteralPath $staging -Destination $OutDir
} catch {
  $swapError = $_
  if ($previousMoved -and -not (Test-Path -LiteralPath $OutDir) -and (Test-Path -LiteralPath $backup)) {
    try { Move-Item -LiteralPath $backup -Destination $OutDir }
    catch { throw "package swap failed ($swapError) and rollback failed: $($_.Exception.Message); previous output remains at '$backup'" }
  }
  throw $swapError
}

# The new output was fully validated before the rename. Failure to remove the old copy is harmless and
# intentionally non-fatal: leaving a clearly named backup is safer than turning successful packaging
# into an ambiguous recovery attempt.
if (Test-Path -LiteralPath $backup) {
  try { Remove-Item -LiteralPath $backup -Recurse -Force }
  catch { Write-Warning "new package is installed, but previous output remains at '$backup': $($_.Exception.Message)" }
}

$size = '{0:N1} GB' -f ((Get-ChildItem -LiteralPath $OutDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1GB)
Write-Output "[lobium-runtime] capabilities: $($requiredCapabilities.Count) hooks, version $version"
Write-Output "[lobium-runtime] artifacts: $($artifactLedger.files.Count) files, tree $($artifactLedger.treeSha256)"
Write-Output "[lobium-runtime] done -> $OutDir ($size)"
} catch {
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
  throw
}
