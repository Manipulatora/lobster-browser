<#
    Build the Windows Lobster Browser desktop app + NSIS installer.

        powershell -ExecutionPolicy Bypass -File scripts\build-windows-product.ps1

    This is the Windows counterpart to build-linux-product.sh. It stages the Tauri `bundle.resources`
    that a fresh clone does not contain, then builds. Idempotent: re-running skips completed steps
    unless -Force is passed.

    WHAT THIS PRODUCES, AND WHAT IT DOES NOT
    The installer contains the UI, the Rust core, the local automation API, the profile/proxy/template
    SQLite stores, the bundled sidecar and the Lobee extension. It does NOT contain the Lobium engine
    (~350 MB) - that is the downloader model. The app resolves the engine at startup from, in order,
    LOBSTER_LOBIUM_BIN, <resources>\lobium\chrome.exe, then %LOCALAPPDATA%\lobster\lobium\chrome.exe,
    and exports LOBSTER_LOBIUM_BIN/_DIR so the sidecar inherits them. Package the engine with
    scripts\package-lobium-runtime.ps1 and place it in that last path, or publish a win-x64 entry in
    engine-manifest.json so first-run provisioning can download it.

    FONTS ARE NOT BUNDLED IN THE INSTALLER ON WINDOWS - but font isolation still works.
    It is native now (the engine filters DirectWrite / FontDataService lookups against the persona
    list), so buildLobiumLaunchEnv() no longer throws on Windows. What the installer cannot carry is
    the font PACK, because the provisioner shells out to `fc-scan` and fontconfig does not exist here.
    The pack rides with the ENGINE instead: package-lobium-runtime.ps1 -FontPack <dir> writes it beside
    chrome.exe, which is where the app looks. Without a pack, isolation is subtractive only - the
    measurable set is host-intersect-persona, narrower than claimed but never wider than the host.
#>
[CmdletBinding()]
param(
    # Must satisfy the repo's engines range (>=22.12 <25); this is the interpreter that will run the
    # bundled sidecar on the user's machine.
    [string] $NodeVersion = 'v22.23.2',
    [switch] $Force,
    [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$Resources = Join-Path $Root 'apps\desktop\src-tauri\resources'
$Cache = Join-Path $Root '.tools\cache'

function Step([string] $m) { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Ok([string] $m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Die([string] $m)  { Write-Host ''; Write-Host "FAILED: $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------------------------------
Step 'Toolchain'
foreach ($t in @('node', 'npm', 'cargo', 'rustc')) {
    $c = Get-Command $t -ErrorAction SilentlyContinue
    if (-not $c) { Die "$t is not on PATH. Need Node >=22.12 and the Rust MSVC toolchain." }
    Ok "$t  $(& $t --version 2>&1 | Select-Object -First 1)"
}
# rustc must target MSVC, not GNU: the Tauri/WebView2 stack does not build against the GNU ABI.
$hostTriple = (rustc -vV 2>&1 | Select-String '^host:').ToString() -replace '^host:\s*', ''
if ($hostTriple -notlike '*windows-msvc*') { Die "rustc host is '$hostTriple'; need *-pc-windows-msvc" }
Ok "host triple $hostTriple"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vc = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath -format value 2>$null
    if ($vc) { Ok "MSVC C++ toolchain: $vc" } else { Die 'VS Build Tools present but the C++ workload (VC.Tools.x86.x64) is missing' }
} else { Die 'Visual Studio Build Tools not found - install with the "Desktop development with C++" workload' }

# ---------------------------------------------------------------------------------------------------
Step '[1/4] Bundle the self-contained sidecar'
if ((Test-Path (Join-Path $Resources 'sidecar\index.js')) -and -not $Force) {
    Ok 'resources\sidecar already staged (use -Force to rebuild)'
} else {
    Push-Location $Root
    try { node scripts\bundle-sidecar.mjs; if ($LASTEXITCODE -ne 0) { Die 'bundle-sidecar.mjs failed' } }
    finally { Pop-Location }
    Ok 'resources\sidecar'
}

# ---------------------------------------------------------------------------------------------------
Step "[2/4] Vendor the Windows Node runtime ($NodeVersion)"
# Deliberately DOWNLOADED, never copied from this host. build-linux-product.sh does
# `cp $(command -v node)`, which on Windows would vendor whatever interpreter the builder happens to
# have - and on a Linux builder produces an ELF that cannot run on Windows at all (docs/STATUS.md section 2
# calls this "broken by construction"). Fetch the official archive and verify it against nodejs.org's
# signed SHASUMS256.txt so the shipped interpreter is provably stock.
$nodeDst = Join-Path $Resources 'node'
if ((Test-Path (Join-Path $nodeDst 'node.exe')) -and -not $Force) {
    Ok "resources\node already staged ($(& (Join-Path $nodeDst 'node.exe') --version))"
} else {
    New-Item -ItemType Directory -Force $Cache | Out-Null
    $zipName = "node-$NodeVersion-win-x64.zip"
    $zip = Join-Path $Cache $zipName
    if (-not (Test-Path $zip)) {
        Write-Host "    downloading $zipName ..."
        Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$zipName" -OutFile $zip -UseBasicParsing -TimeoutSec 1800
    }
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 300).Content
    $expected = (($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($zipName) }) -split '\s+')[0]
    if (-not $expected) { Die "no SHA256 published for $zipName" }
    if ($actual -ne $expected) { Die "SHA256 mismatch for $zipName`n  got      $actual`n  expected $expected" }
    Ok "SHA256 verified against nodejs.org"

    Remove-Item $nodeDst -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $nodeDst | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        foreach ($want in @('node.exe', 'LICENSE')) {
            $entry = $archive.Entries | Where-Object { $_.FullName -eq "node-$NodeVersion-win-x64/$want" }
            if (-not $entry) { Die "$want missing from $zipName" }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $nodeDst $want), $true)
        }
    } finally { $archive.Dispose() }
    Ok "resources\node\node.exe  $(& (Join-Path $nodeDst 'node.exe') --version)"
}

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

# ---------------------------------------------------------------------------------------------------
if ($SkipBuild) { Step 'Stopping before the build (-SkipBuild)'; exit 0 }

Step '[4/4] Build the app + NSIS installer'
Push-Location (Join-Path $Root 'apps\desktop')
try {
    npm run tauri -- build --bundles nsis
    if ($LASTEXITCODE -ne 0) { Die "tauri build failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

$releaseDir = Join-Path $Root 'apps\desktop\src-tauri\target\release'
$exe = Join-Path $releaseDir 'lobster-desktop.exe'
$installer = Get-ChildItem (Join-Path $releaseDir 'bundle\nsis') -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1

Write-Host ''
Write-Host '======== Windows product ========' -ForegroundColor Green
# NOTE: the format operator must be wrapped in parentheses here. `Write-Host "..." -f x` does NOT
# format - PowerShell binds -f as the abbreviation of -ForegroundColor and fails to parse.
if (Test-Path $exe) {
    Write-Host ('  exe       : {0}  ({1:N1} MB)' -f $exe, ((Get-Item $exe).Length / 1MB))
}
if ($installer) {
    Write-Host ('  installer : {0}  ({1:N1} MB)' -f $installer.FullName, ($installer.Length / 1MB))
}
$engineDir = Join-Path $env:LOCALAPPDATA 'lobster\lobium'
if (Test-Path (Join-Path $engineDir 'chrome.exe')) {
    Write-Host ('  engine    : {0}  (found; the app will use it)' -f $engineDir) -ForegroundColor Green
} else {
    Write-Host '  NOTE: no engine at ' -NoNewline -ForegroundColor Yellow
    Write-Host $engineDir -NoNewline -ForegroundColor Yellow
    Write-Host ' - profile launch will fail closed until one is placed there' -ForegroundColor Yellow
    Write-Host '        (scripts\package-lobium-runtime.ps1, then copy the output there)' -ForegroundColor Yellow
}
Write-Host '=================================' -ForegroundColor Green
