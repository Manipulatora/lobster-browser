<#
    Build the Windows Lobster Browser desktop app + NSIS installer.

        powershell -ExecutionPolicy Bypass -File scripts\build-windows-product.ps1

    This is the Windows counterpart to build-linux-product.sh. It stages the Tauri `bundle.resources`
    that a fresh clone does not contain, then builds. Re-running always rebuilds source-derived
    resources; -Force also refreshes cached platform dependencies such as the Node runtime.

    WHAT THIS PRODUCES, AND WHAT IT DOES NOT
    The installer contains the UI, the Rust core, the local automation API, the profile/proxy/template
    SQLite stores, the bundled sidecar and the Lobee extension. It does NOT contain the Lobium engine
    (~350 MB) - that is the downloader model. The app resolves the engine at startup from, in order,
    LOBSTER_LOBIUM_BIN, <resources>\lobium\chrome.exe, then %LOCALAPPDATA%\lobster\lobium\chrome.exe,
    and exports LOBSTER_LOBIUM_BIN/_DIR so the sidecar inherits them. For local validation before a
    win-x64 release exists, package/install the engine and set LOBSTER_LOBIUM_BIN to its chrome.exe
    BEFORE starting the app. A distributable build instead needs a win-x64 engine-manifest entry so
    first-run provisioning can verify and download the published archive.

    FONTS ARE NOT BUNDLED IN THE INSTALLER ON WINDOWS - but font isolation still works.
    It is native now (the engine filters DirectWrite / FontDataService lookups against the persona
    list), so buildLobiumLaunchEnv() no longer throws on Windows. What the installer cannot carry is
    the font PACK: production packaging must separately prove every declared family against the bytes
    with an explicit reviewed fc-scan executable. The pack rides with the ENGINE instead:
    package-lobium-runtime.ps1 -FontPack <dir> -FontScanner <fc-scan.exe> writes it beside chrome.exe,
    which is where the app looks. Without a pack, isolation is subtractive only - the
    measurable set is host-intersect-persona, narrower than claimed but never wider than the host.
#>
[CmdletBinding()]
param(
    # Must satisfy the repo's engines range (>=22.12 <25); this is the interpreter that will run the
    # bundled sidecar on the user's machine.
    [string] $NodeVersion = 'v22.23.2',
    [switch] $Force,
    [switch] $SkipBuild,
    # Build an installer that is meant to be handed to a user. Adds the checks a developer build does
    # not need but a release cannot ship without - today, that the engine manifest can actually serve
    # this platform.
    [switch] $Release
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$Resources = Join-Path $Root 'apps\desktop\src-tauri\resources'
$Cache = Join-Path $Root '.tools\cache'

function Step([string] $m) { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Ok([string] $m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Die([string] $m)  { Write-Host ''; Write-Host "FAILED: $m" -ForegroundColor Red; exit 1 }

function Assert-SupportedNodeVersion([string] $Version, [string] $Label) {
    $match = [regex]::Match($Version.Trim(), '^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$')
    if (-not $match.Success) { Die "$Label reported '$Version'; expected a stable vMAJOR.MINOR.PATCH version" }
    $major = [int]$match.Groups['major'].Value
    $minor = [int]$match.Groups['minor'].Value
    if ($major -lt 22 -or $major -ge 25 -or ($major -eq 22 -and $minor -lt 12)) {
        Die "$Label $Version is outside the supported range >=22.12 <25"
    }
}

function Assert-FreshArtifact([string] $Label, [string] $Path, [datetime] $BuildStartedUtc) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Die "$Label was not produced at the exact expected path: $Path"
    }
    $artifact = Get-Item -LiteralPath $Path
    if ($artifact.Length -le 0) { Die "$Label is empty: $Path" }
    if ($artifact.LastWriteTimeUtc -lt $BuildStartedUtc) {
        Die "$Label predates this build invocation: $Path"
    }
    return $artifact
}

# ---------------------------------------------------------------------------------------------------
Step 'Toolchain'
foreach ($t in @('node', 'npm', 'cargo', 'rustc')) {
    $c = Get-Command $t -ErrorAction SilentlyContinue
    if (-not $c) { Die "$t is not on PATH. Need Node >=22.12 and the Rust MSVC toolchain." }
    Ok "$t  $(& $t --version 2>&1 | Select-Object -First 1)"
}
$hostNodeVersion = ((& node --version 2>&1 | Select-Object -First 1).ToString()).Trim()
Assert-SupportedNodeVersion $hostNodeVersion 'host Node'
# rustc must target MSVC, not GNU: the Tauri/WebView2 stack does not build against the GNU ABI.
$hostTriple = (rustc -vV 2>&1 | Select-String '^host:').ToString() -replace '^host:\s*', ''
if ($hostTriple -ne 'x86_64-pc-windows-msvc') { Die "rustc host is '$hostTriple'; need x86_64-pc-windows-msvc" }
Ok "host triple $hostTriple"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vc = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath -format value 2>$null
    if ($vc) { Ok "MSVC C++ toolchain: $vc" } else { Die 'VS Build Tools present but the C++ workload (VC.Tools.x86.x64) is missing' }
} else { Die 'Visual Studio Build Tools not found - install with the "Desktop development with C++" workload' }

# ---------------------------------------------------------------------------------------------------
Step '[1/4] Bundle the self-contained sidecar'
# A staged file proves only that some bundle once succeeded, not that it contains the current
# workspace sources. bundle-sidecar.mjs rebuilds every input package and smoke-tests the artifact,
# so it must run on every product build rather than relying on an existence check.
Push-Location $Root
try { node scripts\bundle-sidecar.mjs; if ($LASTEXITCODE -ne 0) { Die 'bundle-sidecar.mjs failed' } }
finally { Pop-Location }
Ok 'resources\sidecar'

# ---------------------------------------------------------------------------------------------------
Step "[2/4] Vendor the Windows Node runtime ($NodeVersion)"
# Deliberately DOWNLOADED, never copied from this host. build-linux-product.sh does
# `cp $(command -v node)`, which on Windows would vendor whatever interpreter the builder happens to
# have - and on a Linux builder produces an ELF that cannot run on Windows at all (docs/STATUS.md section 2
# calls this "broken by construction"). Fetch the official archive and verify it against nodejs.org's
# HTTPS-served SHASUMS256.txt. This authenticates the checksum source with TLS; it does not claim a
# detached-signature verification that this script does not perform.
$requestedNodeVersion = $NodeVersion.Trim()
Assert-SupportedNodeVersion $requestedNodeVersion 'vendored Node'
$nodeDst = Join-Path $Resources 'node'
New-Item -ItemType Directory -Force $Cache | Out-Null
$zipName = "node-$requestedNodeVersion-win-x64.zip"
$zip = Join-Path $Cache $zipName
if ($Force -and (Test-Path -LiteralPath $zip -PathType Leaf)) {
    Remove-Item -LiteralPath $zip -Force
}
if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) {
    Write-Host "    downloading $zipName ..."
    Invoke-WebRequest "https://nodejs.org/dist/$requestedNodeVersion/$zipName" -OutFile $zip -UseBasicParsing -TimeoutSec 1800
}
$actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$sums = (Invoke-WebRequest "https://nodejs.org/dist/$requestedNodeVersion/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 300).Content
$expected = (($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($zipName) }) -split '\s+')[0]
if (-not $expected) { Die "no SHA256 published for $zipName" }
if ($actual -ne $expected) { Die "SHA256 mismatch for $zipName`n  got      $actual`n  expected $expected" }
Ok "SHA256 verified against nodejs.org over HTTPS"

# Always reconstruct the staged runtime from the authenticated archive. A pre-existing node.exe is
# not evidence that it came from this archive, so correctness must not depend on passing -Force.
Remove-Item -LiteralPath $nodeDst -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $nodeDst | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    foreach ($want in @('node.exe', 'LICENSE')) {
        $entry = $archive.Entries | Where-Object { $_.FullName -eq "node-$requestedNodeVersion-win-x64/$want" }
        if (-not $entry) { Die "$want missing from $zipName" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $nodeDst $want), $true)
    }
} finally { $archive.Dispose() }
$stagedNodeVersion = ((& (Join-Path $nodeDst 'node.exe') --version 2>&1 | Select-Object -First 1).ToString()).Trim()
if ($stagedNodeVersion -ne $requestedNodeVersion) {
    Die "staged node.exe reports '$stagedNodeVersion', expected '$requestedNodeVersion'"
}
Ok "resources\node\node.exe  $stagedNodeVersion"

# ---------------------------------------------------------------------------------------------------
Step '[3/4] Build the Lobee side-panel extension'
# Always rebuilt: publishing a stale bundle is how the shipped extension silently drifted from source
# before (see the comment at the top of scripts/build-lobee.mjs).
Push-Location $Root
try { node scripts\build-lobee.mjs; if ($LASTEXITCODE -ne 0) { Die 'build-lobee.mjs failed' } }
finally { Pop-Location }
Ok 'resources\lobee'

Step 'Resource inventory (tauri.conf.json bundle.resources)'
foreach ($r in @('sidecar', 'node', 'lobee', 'engine-manifest.json')) {
    $p = Join-Path $Resources $r
    if (Test-Path $p) { Ok $r } else { Die "resources\$r is missing - tauri-build will refuse to bundle" }
}
Write-Host '    --  fonts: intentionally absent on Windows (see the header comment)' -ForegroundColor DarkGray

# The installer does not carry the engine, so a user who installs it can only launch a profile if
# first-run provisioning finds a win-x64 entry in the manifest. engine_provision.rs fails closed when
# the host platform is absent, which means an installer shipped ahead of the archive is an app that
# installs cleanly and then dead-ends on its one core action. A developer building locally can use the
# explicit LOBSTER_LOBIUM_BIN override for their packaged engine, so it is only fatal with -Release.
$manifest = Get-Content (Join-Path $Resources 'engine-manifest.json') -Raw | ConvertFrom-Json
$winEntry = $manifest.platforms.'win-x64'
if ($winEntry -and $winEntry.url) {
    Ok "engine manifest serves win-x64 ($($winEntry.version))"
} elseif ($Release) {
    Die 'engine-manifest.json has no win-x64 entry - this installer cannot provision an engine. Publish the archive (scripts\package-lobium-runtime.ps1, then bump-engine-version.mjs) before building a release.'
} else {
    Write-Host '    --  engine manifest has no win-x64 entry: this build is NOT distributable' -ForegroundColor Yellow
    Write-Host '        (fine locally with LOBSTER_LOBIUM_BIN set before the app starts)' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------------------------------
if ($SkipBuild) { Step 'Stopping before the build (-SkipBuild)'; exit 0 }

Step '[4/4] Build the app + NSIS installer'
$releaseDir = Join-Path $Root 'apps\desktop\src-tauri\target\release'
$tauriConfig = Get-Content (Join-Path $Root 'apps\desktop\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$expectedExe = Join-Path $releaseDir 'lobster-desktop.exe'
$expectedInstaller = Join-Path $releaseDir ('bundle\nsis\{0}_{1}_x64-setup.exe' -f $tauriConfig.productName, $tauriConfig.version)
$expectedNsi = Join-Path $releaseDir 'nsis\x64\installer.nsi'

# Removing only the three exact outputs makes an incremental Cargo/Tauri run prove it recreated each
# artifact. Unrelated versions and architectures remain untouched and cannot satisfy the checks below.
foreach ($oldArtifact in @($expectedExe, $expectedInstaller, $expectedNsi)) {
    Remove-Item -LiteralPath $oldArtifact -Force -ErrorAction SilentlyContinue
}
$buildStartedUtc = [DateTime]::UtcNow
Push-Location (Join-Path $Root 'apps\desktop')
try {
    # Tauri exposes trailing ARGS to its Cargo runner; the explicit separator makes --locked a Cargo
    # argument, so Cargo.lock cannot be silently rewritten during a product build.
    npm run tauri -- build --bundles nsis -- --locked
    if ($LASTEXITCODE -ne 0) { Die "tauri build failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

$exe = Assert-FreshArtifact 'desktop executable' $expectedExe $buildStartedUtc
$installer = Assert-FreshArtifact 'NSIS installer' $expectedInstaller $buildStartedUtc
$nsi = Assert-FreshArtifact 'generated installer.nsi' $expectedNsi $buildStartedUtc

Write-Host ''
Write-Host '======== Windows product ========' -ForegroundColor Green
# NOTE: the format operator must be wrapped in parentheses here. `Write-Host "..." -f x` does NOT
# format - PowerShell binds -f as the abbreviation of -ForegroundColor and fails to parse.
Write-Host ('  exe       : {0}  ({1:N1} MB)' -f $exe.FullName, ($exe.Length / 1MB))
Write-Host ('  installer : {0}  ({1:N1} MB)' -f $installer.FullName, ($installer.Length / 1MB))
Write-Host ('  NSIS script: {0}' -f $nsi.FullName)
$engineDir = Join-Path $env:LOCALAPPDATA 'lobster\lobium'
if (Test-Path (Join-Path $engineDir 'chrome.exe')) {
    Write-Host ('  engine    : {0}  (found for local override)' -f $engineDir) -ForegroundColor Green
    Write-Host ('        set LOBSTER_LOBIUM_BIN={0}' -f (Join-Path $engineDir 'chrome.exe')) -ForegroundColor DarkGray
} else {
    Write-Host '  NOTE: no engine at ' -NoNewline -ForegroundColor Yellow
    Write-Host $engineDir -NoNewline -ForegroundColor Yellow
    Write-Host ' - profile launch will fail closed until one is placed there' -ForegroundColor Yellow
    Write-Host '        (package/copy it, then set LOBSTER_LOBIUM_BIN before starting the app)' -ForegroundColor Yellow
}
Write-Host '=================================' -ForegroundColor Green
