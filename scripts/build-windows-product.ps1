<#
    Build the Windows Lobster Browser desktop app + NSIS installer.

        powershell -ExecutionPolicy Bypass -File scripts\build-windows-product.ps1

    This is the Windows counterpart to build-linux-product.sh. It stages the Tauri `bundle.resources`
    that a fresh clone does not contain, then builds. Re-running always rebuilds source-derived
    resources; -Force also refreshes cached platform dependencies such as the Node runtime.

    WHAT THIS PRODUCES
    The installer contains the UI, the Rust core, the local automation API, the profile/proxy/template
    SQLite stores, the bundled sidecar and the Lobee extension. It does NOT contain the Lobium engine:
    that is ~300 MB compressed against a ~35 MB app, and embedding it produced an installer six times
    the size of what competitors in this category ship. The engine is downloaded on first run from the
    URL and SHA-256 pinned in resources\engine-manifest.json.
    The app resolves the engine at startup from, in order, LOBSTER_LOBIUM_BIN,
    <resources>\lobium\chrome.exe (honoured if some build does embed one), then
    %LOCALAPPDATA%\lobster\lobium\chrome.exe, and exports LOBSTER_LOBIUM_BIN/_DIR so the sidecar
    inherits them.
    The win-x64 engine-manifest entry is therefore what makes the installer USABLE. A missing or
    unreachable one means every Windows first run fails after the user has already installed.

    THE FONT PACK SHIPS INSIDE THE ENGINE, so it arrives with the first-run download, NOT with this
    installer. Isolation is native (the engine filters DirectWrite / FontDataService lookups against
    the persona list), so buildLobiumLaunchEnv() no longer throws on Windows. The pack is not
    assembled here: it rides with the ENGINE, because production packaging must prove every declared
    family against the bytes with an explicit reviewed fc-scan executable, and that proof belongs
    where the runtime is built. package-lobium-runtime.ps1 -FontPack <dir> -FontScanner <fc-scan.exe>
    writes it beside chrome.exe, which is where the app looks.

    A pack is not optional on Windows. Measured 2026-08-26: a persona whose claimed families are
    absent from the host and which names no pack makes the engine fail to build its restricted
    DirectWrite fallback (lobium_fonts.cc:535) and the browser then never produces a page target at
    all - it starts and does nothing. So the pack's presence is verified where the runtime is
    packaged, not here, and this installer simply never sees it.
#>
[CmdletBinding()]
param(
    # Must satisfy the repo's engines range (>=22.12 <25); this is the interpreter that will run the
    # bundled sidecar on the user's machine.
    [string] $NodeVersion = 'v22.23.2',
    [switch] $Force,
    [switch] $SkipBuild,
    # Build the BUNDLED installer: the engine ships inside it and first run needs no download.
    #
    # Same tree, same binary, same manifest. The only differences are that resources\lobium is staged
    # (bundled in via --config src-tauri/tauri.bundled.conf.json) and that a .lobium-engine-version
    # stamp is written beside the engine. Run this script twice from one checkout, once with and once
    # without, so the two installers cannot drift.
    [switch] $Bundled,
    # The packaged Lobium runtime to embed with -Bundled. Its ZIP must be the one the manifest's
    # win-x64 entry names, because the stamp written beside it carries that entry's digest.
    [string] $EngineRuntime
    # -Release is gone, but the check it used to gate is NOT optional any more, which is why there is
    # no switch for it. Its job was to refuse a build whose engine manifest had no usable win-x64
    # entry. Under the download-on-first-run model that entry is the only thing that makes the
    # installer work at all, so the refusal is unconditional (see the Die in the resource-inventory
    # step). A switch here would only offer the operator a way to turn off the one check that matters.
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

Step $(if ($Bundled) { '[3b/4] Stage the engine INTO resources (bundled build)' } else { '[3b/4] The engine is NOT staged into resources (web build)' })
# TWO INSTALLERS FROM ONE TREE. The WEB installer downloads the engine on first run from the URL and
# SHA-256 in resources\engine-manifest.json, into %LOCALAPPDATA%\lobster\lobium; the BUNDLED one
# carries it. Everything else about them is identical, which is the point - a difference that is not
# the engine is a bug.
#
# tauri bundles whatever is in the resource tree, so the web build must actively REMOVE a runtime an
# earlier bundled build left behind. Otherwise it silently ships the 800 MB it claims not to carry.
$engineDest = Join-Path $Resources 'lobium'
if (-not $Bundled) {
    if (Test-Path $engineDest) {
        Write-Host '    removing a runtime left by an earlier bundled build ...'
        Remove-Item -LiteralPath $engineDest -Recurse -Force
    }
    Ok 'engine excluded (downloaded on first run)'
} else {
    $src = $EngineRuntime
    if (-not $src) {
        $src = @(Get-ChildItem (Join-Path $Root 'dist-win') -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'lobium-runtime-*' } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -ExpandProperty FullName) |
            Where-Object { Test-Path (Join-Path $_ 'chrome.exe') } |
            Select-Object -First 1
    }
    if (-not $src) { Die '-Bundled needs a packaged Lobium runtime; pass -EngineRuntime <dir>' }

    # Verify BEFORE embedding. An installer is the worst place to discover a bad engine: every user
    # gets the same broken bytes and the failure surfaces at first profile launch.
    Push-Location $Root
    try {
        node scripts\verify-lobium-runtime.mjs $src
        if ($LASTEXITCODE -ne 0) { Die "the runtime at $src did not verify; refusing to embed it" }
    } finally { Pop-Location }

    if (Test-Path $engineDest) { Remove-Item -LiteralPath $engineDest -Recurse -Force }
    Write-Host "    copying $src -> resources\lobium ..."
    Copy-Item -LiteralPath $src -Destination $engineDest -Recurse -Force

    # THE STAMP IS THE WHOLE POINT OF THIS BRANCH, AND ITS ABSENCE IS SILENT.
    #
    # engine_matches_source() answers "is the installed engine the one the manifest names" by reading
    # .lobium-engine-version beside chrome.exe and comparing it by EXACT STRING EQUALITY against
    # source_stamp(), which is format!("version={}\nsha256={}\n") over the manifest entry. A bundled
    # engine with no stamp answers "no match" however correct its bytes are, so the app concludes it
    # has no engine the manifest recognises and provisions one - on every launch of a fresh install.
    # That is exactly the download bundling exists to remove, and it is invisible: the browser still
    # works, because ensure_lobium_env accepts the embedded binary on existence alone.
    #
    # The digest is the ZIP's, not the directory's. It identifies the manifest ENTRY, and the manifest
    # is what the comparison is against.
    $stampEntry = (Get-Content (Join-Path $Resources 'engine-manifest.json') -Raw | ConvertFrom-Json).platforms.'win-x64'
    if (-not ($stampEntry -and $stampEntry.version -and $stampEntry.sha256)) {
        Die 'cannot stamp the bundled engine: engine-manifest.json has no usable win-x64 entry'
    }
    # LF and a trailing newline, written without a BOM. The Rust side compares the whole file to a
    # format! string, so Set-Content (CRLF) or a BOM would make every comparison fail - the same
    # silent no-match the stamp exists to prevent.
    $stampText = "version=$($stampEntry.version)`nsha256=$($stampEntry.sha256.ToLower())`n"
    [System.IO.File]::WriteAllText(
        (Join-Path $engineDest '.lobium-engine-version'),
        $stampText,
        (New-Object System.Text.UTF8Encoding($false)))

    $engineBytes = (Get-ChildItem $engineDest -Recurse -File | Measure-Object -Property Length -Sum).Sum
    Ok ('resources\lobium  ({0:N2} GB)  stamped version={1} sha256={2}...' -f `
        ($engineBytes / 1GB), $stampEntry.version, $stampEntry.sha256.Substring(0, 8))
}

Step 'Resource inventory (tauri.conf.json bundle.resources)'
$required = @('sidecar', 'node', 'lobee', 'engine-manifest.json')
if ($Bundled) { $required += 'lobium' }
foreach ($r in $required) {
    $p = Join-Path $Resources $r
    if (Test-Path $p) { Ok $r } else { Die "resources\$r is missing - tauri-build will refuse to bundle" }
}
Write-Host '    --  fonts: intentionally absent on Windows (see the header comment)' -ForegroundColor DarkGray

# The installer does NOT carry the engine, so this entry is what makes it usable: without a reachable
# win-x64 URL every Windows first run fails after the user has already installed. That is a release
# blocker, not a note.
$manifest = Get-Content (Join-Path $Resources 'engine-manifest.json') -Raw | ConvertFrom-Json
$winEntry = $manifest.platforms.'win-x64'
if (-not ($winEntry -and $winEntry.url -and $winEntry.sha256)) {
    Die ('engine-manifest.json has no usable win-x64 entry (url + sha256). The installer does not ' +
         'carry an engine, so every first run would fail. Publish the engine and run ' +
         'scripts\bump-engine-version.mjs before building a release.')
}
if ($winEntry.stale) {
    Write-Host "    !!  win-x64 entry is marked stale: $($winEntry.stale)" -ForegroundColor Yellow
}
Ok "engine manifest serves win-x64 ($($winEntry.version))"

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
    # The bundled build differs by exactly one argument. Everything upstream of here - the Rust
    # binary, the frontend, the sidecar, the manifest - is the same tree and the same compilation.
    if ($Bundled) {
        npm run tauri -- build --bundles nsis --config src-tauri/tauri.bundled.conf.json -- --locked
    } else {
        npm run tauri -- build --bundles nsis -- --locked
    }
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
# WHERE THE ENGINE COMES FROM, reported truthfully for the model this script actually builds.
#
# This block used to test for an EMBEDDED runtime at <resources>\lobium\chrome.exe and print a red
# two-line alarm when it was absent. That was correct for exactly one day. 511481d embedded the
# engine and added this check; 0e0831d reverted to download-on-first-run and rewrote step 3b to
# DELETE that very directory - but left this block behind. So every successful build ended by
# announcing "this installer does NOT carry an engine / every install will report a damaged
# installation", which is false under the current model and is the last thing the operator sees:
# a correct build looked like a broken one.
#
# The presence check IS meaningful again, but only in -Bundled mode, and only because step 3b puts
# the runtime there deliberately. In web mode step 3b removes it, so testing for it there could only
# ever fail - which is the trap the paragraph above describes. Branch on the mode, never on the
# directory alone.
$manifestPath = Join-Path $Resources 'engine-manifest.json'
$winEntry = $null
if (Test-Path $manifestPath) {
    try {
        $winEntry = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).platforms.'win-x64'
    } catch {
        Write-Host '  engine    : engine-manifest.json is present but could not be parsed' -ForegroundColor Red
    }
}
if ($winEntry -and $winEntry.url -and $winEntry.sha256) {
    if ($Bundled) {
        # Report the embedded engine AND its stamp. The stamp is the difference between a bundled
        # install that never downloads and one that re-downloads on every launch, and it is invisible
        # from the outside, so it is stated here rather than assumed.
        $stampPath = Join-Path (Join-Path $Resources 'lobium') '.lobium-engine-version'
        $stamped = if (Test-Path $stampPath) {
            [System.IO.File]::ReadAllText($stampPath) -eq
                ("version=$($winEntry.version)`nsha256=$($winEntry.sha256.ToLower())`n")
        } else { $false }
        $bundledBytes = (Get-ChildItem (Join-Path $Resources 'lobium') -Recurse -File |
            Measure-Object -Property Length -Sum).Sum
        Write-Host ('  engine    : BUNDLED, no first-run download  (v{0}, {1:N2} GB on disk)' -f $winEntry.version, ($bundledBytes / 1GB)) -ForegroundColor Green
        Write-Host ('        sha256 {0}   (the manifest entry the stamp names)' -f $winEntry.sha256) -ForegroundColor DarkGray
        if ($stamped) {
            Write-Host '        stamp  .lobium-engine-version matches the manifest entry' -ForegroundColor DarkGray
        } else {
            Write-Host '  WARNING: the bundled engine has no matching .lobium-engine-version stamp.' -ForegroundColor Red
            Write-Host '        Every launch of a fresh install will re-download the engine, which is' -ForegroundColor Red
            Write-Host '        the exact cost bundling exists to remove. Do not ship this installer.' -ForegroundColor Red
        }
    } else {
        Write-Host ('  engine    : downloaded on first run  (v{0})' -f $winEntry.version) -ForegroundColor Green
        Write-Host ('        from   {0}' -f $winEntry.url) -ForegroundColor DarkGray
        Write-Host ('        sha256 {0}' -f $winEntry.sha256) -ForegroundColor DarkGray
        Write-Host '        into   %LOCALAPPDATA%\lobster\lobium' -ForegroundColor DarkGray
    }
    # A `stale` marker means the repo itself says these bytes must not be shipped. Say so loudly:
    # engine_provision.rs ignores unknown manifest keys, so nothing downstream will catch it.
    if ($winEntry.PSObject.Properties.Name -contains 'stale') {
        Write-Host '  WARNING: the win-x64 manifest entry is marked STALE - do not ship this installer' -ForegroundColor Red
        Write-Host ('        {0}' -f $winEntry.stale) -ForegroundColor Red
    }
} else {
    Write-Host '  WARNING: engine-manifest.json has no usable win-x64 entry' -ForegroundColor Red
    Write-Host '        first run cannot provision an engine and will fail after installation' -ForegroundColor Red
}
Write-Host '=================================' -ForegroundColor Green
