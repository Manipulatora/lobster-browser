<#
    Lobium engine build driver for WINDOWS.

    The Windows counterpart to build.sh. build.sh is bash-only and its staging step
    (`cp src/* .../components/lobium_fp/`) plus its `quilt push -a` have no Windows equivalent, so
    a Windows engine could not be produced at all before this script existed.

        $env:LOBIUM_CHROMIUM_SRC = '<path-to-chromium-src>'
        powershell -ExecutionPolicy Bypass -File lobium\build.ps1               # dry run: print the plan
        powershell -ExecutionPolicy Bypass -File lobium\build.ps1 -Run          # stage + patch + gen + build
        powershell -ExecutionPolicy Bypass -File lobium\build.ps1 -Run -Stop gen    # stop after `gn gen`
        powershell -ExecutionPolicy Bypass -File lobium\build.ps1 -Run -Targets "v8_snapshot skia"
        powershell -ExecutionPolicy Bypass -File lobium\build.ps1 -Run -Jobs 6   # 16 GB / 8-thread host

    PREREQUISITES on the build host (all verified below before anything is touched):
      * depot_tools on PATH, DEPOT_TOOLS_WIN_TOOLCHAIN=0
      * Visual Studio 2022 Build Tools with the "Desktop development with C++" workload
      * A Windows 10/11 SDK including "Debugging Tools for Windows"
      * A Chromium checkout synced to the pinned tag, with the win64 PGO profile downloaded
      * ~200 GB free on the checkout volume

    Re-running the patch step requires -Force. Without it, any tracked checkout drift, reject
    artifact, or patch-created file is rejected before patching begins.
#>
[CmdletBinding()]
param(
    # Execute. Without this the script prints what it would do and changes nothing.
    [switch] $Run,
    # Chromium source checkout (the directory containing .gn, DEPS, chrome/, third_party/).
    [string] $SrcDir = $env:LOBIUM_CHROMIUM_SRC,
    # Output directory, relative to $SrcDir.
    [string] $OutDir = 'out\Lobium',
    # Stop after a given step: stage | patch | gen | build.
    [ValidateSet('stage', 'patch', 'gen', 'build')]
    [string] $Stop = 'build',
    # Ninja targets. Default builds the browser. Pass a subset to warm the object cache.
    [string] $Targets = 'chrome',
    # Parallel compile jobs. 0 lets autoninja choose, which it does from core count alone.
    #
    # Core count is the wrong question on a small-memory host: each cl.exe holds 1-2 GB, so eight of
    # them on a 16 GB laptop pages to disk and finishes SLOWER than six that stay resident. Set this
    # to about (RAM_GB / 2) when the machine has less than 4 GB per logical core.
    [int] $Jobs = 0,
    # Reset tracked files and re-apply the series from the pinned checkout.
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Repo = Split-Path -Parent $Here

# The pinned Chromium release tag. Kept in lockstep with build.sh CHROMIUM_REF and with
# ENGINE_CHROME in packages/fingerprint/src/pools.ts; ci/validation/version-coherence.test.mjs
# fails the build if the three ever disagree. It MUST be a build Google shipped on a release
# channel - never a canary, whose `.0` patch component is itself a branch-point signature and
# whose build number is near-unique in getHighEntropyValues(['fullVersionList']).
$ChromiumRef = '152.0.7977.75'

function Step([string] $m) { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Ok([string] $m) { Write-Host "    OK   $m" -ForegroundColor Green }
function Info([string] $m) { Write-Host "    --   $m" -ForegroundColor DarkGray }
function Die([string] $m) { Write-Host ''; Write-Host "FAILED: $m" -ForegroundColor Red; exit 1 }
function Plan([string] $m) { Write-Host "    would: $m" -ForegroundColor Yellow }

if (-not $SrcDir) {
    Die 'Chromium checkout is not configured. Pass -SrcDir or set LOBIUM_CHROMIUM_SRC to the directory containing .gn.'
}

$stepOrder = @{ stage = 1; patch = 2; gen = 3; build = 4 }
function ShouldRun([string] $name) { return $stepOrder[$name] -le $stepOrder[$Stop] }

# ==================================================================================================
Step "Lobium Windows build  (ref $ChromiumRef, src $SrcDir, out $OutDir)"
if (-not $Run) { Write-Host '    DRY RUN - pass -Run to execute.' -ForegroundColor Yellow }

# --------------------------------------------------------------------------------------------
Step '0. Preflight'

$gitExe = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
if (-not $gitExe) { Die 'git is not on PATH.' }
Ok "git    $gitExe"

$patchExe = (Get-Command patch.exe -ErrorAction SilentlyContinue).Source
if (-not $patchExe) { $patchExe = 'C:\Program Files\Git\usr\bin\patch.exe' }
if (-not (Test-Path $patchExe)) { Die 'GNU patch not found (install Git for Windows, which ships usr\bin\patch.exe).' }
Ok "patch  $patchExe"

foreach ($t in @('gn.bat', 'autoninja.bat')) {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { Die "$t is not on PATH - add depot_tools." }
}
Ok 'depot_tools on PATH'

if ($env:DEPOT_TOOLS_WIN_TOOLCHAIN -ne '0') {
    Die 'DEPOT_TOOLS_WIN_TOOLCHAIN must be 0 to use the locally installed Visual Studio (Google''s hermetic toolchain package is internal-only).'
}
Ok 'DEPOT_TOOLS_WIN_TOOLCHAIN=0'

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { Die 'Visual Studio Installer not found.' }
$vc = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath -format value 2>$null
if (-not $vc) { Die 'The MSVC C++ toolchain (VC.Tools.x86.x64) is not installed.' }
if ($vc -is [array]) { $vc = $vc[0] }
Ok "MSVC   $vc"

# Tell Chromium's toolchain detector exactly where VS lives.
#
# build/vs_toolchain.py only probes the DEFAULT install roots - for 2022 that is
# %ProgramFiles%\Microsoft Visual Studio\2022\<edition>. An installation anywhere else (this host has
# Build Tools under "Program Files (x86)") is invisible to it and `gn gen` dies with the very
# unhelpful "No supported Visual Studio can be found". The script reads a `vs<year>_install`
# environment variable first, precisely for this case, so derive it from vswhere rather than
# hardcoding a path or asking anyone to reinstall.
$vsYear = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property catalog_productLineVersion -format value 2>$null
if ($vsYear -is [array]) { $vsYear = $vsYear[0] }
if (-not $vsYear) { $vsYear = '2022' }
Set-Item -Path "env:vs${vsYear}_install" -Value $vc
Ok "vs${vsYear}_install = $vc"

# Chromium also needs the SDK root and the exact SDK version pinned; without WINDOWSSDKDIR the
# toolchain script falls back to its own probing, which has the same default-path assumption.
$sdkRootDir = "${env:ProgramFiles(x86)}\Windows Kits\10"
if (Test-Path $sdkRootDir) { $env:WINDOWSSDKDIR = $sdkRootDir }

# ATL. base/win/atl_throw.cc includes <atldef.h>, so a Build Tools install without the
# "C++ ATL for latest v143 build tools" component compiles ~2000 objects and only then dies with a
# bare "'atldef.h' file not found" 13 minutes in. Check it here instead.
#   setup.exe modify --installPath "<vs>" --add Microsoft.VisualStudio.Component.VC.ATL --quiet --norestart
$atlFound = $false
$msvcRoot = Join-Path $vc 'VC\Tools\MSVC'
if (Test-Path $msvcRoot) {
    foreach ($d in Get-ChildItem $msvcRoot -Directory) {
        if (Test-Path (Join-Path $d.FullName 'atlmfc\include\atldef.h')) { $atlFound = $true; break }
    }
}
if (-not $atlFound) {
    Die @"
The MSVC ATL headers (atlmfc\include\atldef.h) are missing under $msvcRoot.
Chromium's base/win/atl_throw.cc needs them. Install the component:
  & "`${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\setup.exe" modify ``
      --installPath "$vc" --add Microsoft.VisualStudio.Component.VC.ATL --quiet --norestart
"@
}
Ok 'MSVC ATL headers'

$sdkInc = "${env:ProgramFiles(x86)}\Windows Kits\10\Include"
if (-not (Test-Path $sdkInc)) { Die 'No Windows 10/11 SDK found.' }
$sdkVer = (Get-ChildItem $sdkInc -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
Ok "WinSDK $sdkVer"
if (-not (Test-Path "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64")) {
    Die 'Windows SDK "Debugging Tools for Windows" (Debuggers\x64) is missing - the Chromium Windows toolchain requires it.'
}
Ok 'Debugging Tools for Windows'

if (-not (Test-Path (Join-Path $SrcDir '.gn'))) { Die "$SrcDir does not look like a Chromium checkout (no .gn)." }
Push-Location $SrcDir
try {
    $tag = (& git describe --tags --exact-match HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $tag) { Die 'The checkout is not on an exact tag. Run gclient sync to the pinned ref first.' }
    if ($tag.Trim() -ne $ChromiumRef) { Die "Checkout is at tag '$($tag.Trim())' but this script pins '$ChromiumRef'." }
    Ok "checkout at $ChromiumRef"
} finally { Pop-Location }

# Applying onto a partially patched tree is never safe. GNU patch uses the same non-zero status for
# an already-applied hunk and a genuine reject; the old script guessed from English output and could
# accept a mixture of skipped and failed hunks. Refuse any evidence of an earlier apply up front.
# -Force is explicit recovery: it resets tracked files and removes only narrowly scoped artifacts.
if ($Run -and (ShouldRun 'patch') -and -not $Force) {
    $preflightSeries = @(Get-Content (Join-Path $Here 'patches\series') |
        Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*#' } | ForEach-Object { $_.Trim() })
    $patchCreated = @()
    foreach ($p in $preflightSeries) {
        $full = Join-Path $Here "patches\$p"
        if (-not (Test-Path $full)) { Die "series patch is missing: $p" }
        $lines = [System.IO.File]::ReadAllLines($full, [System.Text.Encoding]::UTF8)
        for ($i = 0; $i -lt $lines.Length; $i++) {
            if ($lines[$i] -like 'new file mode*') {
                for ($j = $i; $j -lt [Math]::Min($i + 6, $lines.Length); $j++) {
                    if ($lines[$j] -like '+++ b/*') {
                        $patchCreated += $lines[$j].Substring(6).Trim()
                        break
                    }
                }
            }
        }
    }

    $dirtyReason = $null
    Push-Location $SrcDir
    try {
        & git --no-optional-locks diff --quiet -- .
        if ($LASTEXITCODE -ne 0) { $dirtyReason = 'tracked working-tree changes' }
        if (-not $dirtyReason) {
            & git --no-optional-locks diff --cached --quiet -- .
            if ($LASTEXITCODE -ne 0) { $dirtyReason = 'staged changes' }
        }
        if (-not $dirtyReason) {
            foreach ($rel in ($patchCreated | Sort-Object -Unique)) {
                if (Test-Path (Join-Path $SrcDir ($rel -replace '/', '\'))) {
                    $dirtyReason = "patch-created path already exists: $rel"
                    break
                }
            }
        }
        if (-not $dirtyReason) {
            $artifact = & git --no-optional-locks status --porcelain --untracked-files=all |
                Where-Object { $_ -like '?? *.rej' -or $_ -like '?? *.orig' } |
                Select-Object -First 1
            if ($artifact) { $dirtyReason = "stale patch artifact: $($artifact.Substring(3).Trim('"'))" }
        }
    } finally { Pop-Location }
    if ($dirtyReason) {
        Die "Chromium checkout is not pristine ($dirtyReason). Re-run with -Force to reset and apply the whole series."
    }
    Ok 'checkout is pristine for patch application'
}

# PGO: gn gen with chrome_pgo_phase=2 fails outright without a profile, but failing HERE gives a
# far clearer message than a GN assertion 200 lines into the generate step.
$pgoDir = Join-Path $SrcDir 'chrome\build\pgo_profiles'
$pgo = Get-ChildItem $pgoDir -Filter '*.profdata' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'chrome-win64-*' } | Select-Object -First 1
if (-not $pgo) {
    Die @"
No win64 PGO profile in $pgoDir.
Set custom_vars = { "checkout_pgo_profiles": True } in .gclient, then run:
  python3 $SrcDir\tools\update_pgo_profiles.py --target=win64 update --gs-url-base=chromium-optimization-profiles/pgo_profiles
"@
}
Ok ("PGO    {0}  ({1:N0} MB)" -f $pgo.Name, ($pgo.Length / 1MB))

# V8 ships a SECOND, independent PGO artifact: the builtins profile, fetched by its own gclient
# hook (also gated on checkout_pgo_profiles). Missing it does not fail gn gen - it fails the BUILD,
# with "missing and no known rule to make it" for v8/tools/builtins-pgo/profiles/x64-rl.profile,
# after ninja has already scheduled everything.
$v8Pgo = Join-Path $SrcDir 'v8\tools\builtins-pgo\profiles\x64-rl.profile'
if (-not (Test-Path $v8Pgo)) {
    Die @"
Missing the V8 builtins PGO profile at $v8Pgo. Fetch it:
  python3 $SrcDir\v8\tools\builtins-pgo\download_profiles.py download ``
      --depot-tools $SrcDir\third_party\depot_tools --check-v8-revision
"@
}
Ok ("V8 PGO {0:N0} MB builtins profile" -f ((Get-Item $v8Pgo).Length / 1MB))

$drive = Get-PSDrive -Name (Split-Path -Qualifier $SrcDir).TrimEnd(':')
# Measured on the build box (2026-09-03): the finished out\Lobium for 152.0.7977.42 with this
# gn-args set is 15 GB, and the largest transient the build needs on top of it is a few GB of
# object files. 150 GB was the figure for a symbolised official build; with a 67 GB pack already
# on the volume it refused a machine that had 117 GB free, which is plenty. 100 GB keeps a margin
# for the .git growth a tag fetch brings.
if ($drive.Free / 1GB -lt 100) { Die ("Only {0:N0} GB free on {1}: - the build needs ~100 GB free (out\Lobium is ~15 GB, plus transients)." -f ($drive.Free / 1GB), $drive.Name) }
Ok ("disk   {0:N0} GB free on {1}:" -f ($drive.Free / 1GB), $drive.Name)

$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
Info "host: $cores logical cores, $ramGb GB RAM"
if ($ramGb -lt 16) { Die 'A ThinLTO official build needs at least 16 GB of RAM.' }

# --------------------------------------------------------------------------------------------
# 1. Stage the added first-party module.
#
# Everything in lobium/src/ becomes //components/lobium_fp/. It is an ADDED directory, so it never
# conflicts on an upstream rebase - which is the whole reason the anti-detect logic lives there and
# the patches under lobium/patches/ are only thin hook points.
if (ShouldRun 'stage') {
    Step '1. Stage added files into the Chromium tree'

    $dst = Join-Path $SrcDir 'components\lobium_fp'
    $srcFiles = Get-ChildItem (Join-Path $Here 'src') -File
    if ($Run) {
        New-Item -ItemType Directory -Force $dst | Out-Null
        foreach ($f in $srcFiles) {
            $target = Join-Path $dst $f.Name
            Copy-Item $f.FullName $target -Force
            # Stamp the copy with the CURRENT time. Copy-Item preserves the SOURCE's
            # LastWriteTime, so a kernel edited before the last build but staged after it lands in
            # the tree looking older than the object compiled from its predecessor - and the build
            # system skips it. That produced a link error (`undefined symbol:
            # lobium::FarbleAudioSamples`) whose cause was invisible from the error itself: the
            # callers had recompiled against the new signature, the kernel had not.
            (Get-Item $target).LastWriteTime = Get-Date
        }
        Ok "$($srcFiles.Count) files -> components\lobium_fp\"
    } else {
        Plan "copy $($srcFiles.Count) files from lobium\src\ to components\lobium_fp\"
    }

    # NTP brand icons. branding/ntp-branding.patch adds these four filenames to the generate_grd
    # input_files of chrome/browser/resources/new_tab_page/icons/BUILD.gn, and GN fails outright if
    # the files are not on disk. Nothing staged them before, so the patch series applied cleanly and
    # then the build died in `gn gen` with a missing-input error - the classic "applies but does not
    # build" trap. They are checked-in binaries under lobium/assets/, not generated at build time:
    # scripts/apply-lobium-branding.mjs regenerates them from the brand sources, but that needs
    # Playwright and is a DESIGN-time step, never a prerequisite of a reproducible build.
    $iconSrc = Join-Path $Here 'assets\ntp-icons'
    $iconDst = Join-Path $SrcDir 'chrome\browser\resources\new_tab_page\icons'
    $wanted = @('lobium_master.png', 'lobster_ad.png', 'lobster_wordmark.png', 'lobster_wordmark_horizontal.png')
    $missing = @($wanted | Where-Object { -not (Test-Path (Join-Path $iconSrc $_)) })
    if ($missing.Count) { Die "missing NTP brand icons in lobium\assets\ntp-icons: $($missing -join ', ')" }
    if ($Run) {
        if (-not (Test-Path $iconDst)) { Die "$iconDst does not exist - is the checkout complete?" }
        foreach ($n in $wanted) { Copy-Item (Join-Path $iconSrc $n) (Join-Path $iconDst $n) -Force }
        Ok "$($wanted.Count) NTP brand icons -> chrome\browser\resources\new_tab_page\icons\"
    } else {
        Plan "copy $($wanted.Count) NTP brand icons into chrome\browser\resources\new_tab_page\icons\"
    }
}

# --------------------------------------------------------------------------------------------
# 2. Apply the quilt series, in order.
#
# Order matters: several patches hook the same upstream file and later ones are cut against the
# tree AFTER earlier ones applied (fingerprint/webgl-runtime-safety.patch, for example, cannot
# apply to a pristine tree at all). Never validate a patch in isolation.
if (ShouldRun 'patch') {
    Step '2. Apply the patch series'
    $series = Get-Content (Join-Path $Here 'patches\series') |
        Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*#' } | ForEach-Object { $_.Trim() }
    Info "$($series.Count) patches in lobium\patches\series"

    if ($Run) {
        if ($Force) {
            Push-Location $SrcDir
            try {
                & git checkout -- .
                # Delete ONLY UNTRACKED .rej/.orig files. A bare `-Include *.orig` sweep over the
                # tree is destructive: Chromium vendors ~258 TRACKED Cargo.toml.orig files under
                # third_party/rust/chromium_crates_io, and a glob happily deletes those too.
                # `git status --porcelain` is the authority on what is a build artifact.
                $untracked = & git --no-optional-locks status --porcelain --untracked-files=all |
                    Where-Object { $_ -like '?? *' } |
                    ForEach-Object { $_.Substring(3).Trim('"') } |
                    Where-Object { $_ -like '*.rej' -or $_ -like '*.orig' }
                foreach ($rel in $untracked) {
                    [System.IO.File]::Delete((Join-Path $SrcDir ($rel -replace '/', '\')))
                }
                # Also remove files the series CREATES. `git checkout -- .` cannot revert those
                # (they are untracked), so a re-apply hits "would create the file ... which already
                # exists! Skipping patch" and the patch reports failure. Only paths a patch declares
                # with `new file mode` are touched - never a blanket clean.
                $created = @()
                foreach ($p in $series) {
                    $full = Join-Path $Here "patches\$p"
                    if (-not (Test-Path $full)) { continue }
                    $lines = [System.IO.File]::ReadAllLines($full, [System.Text.Encoding]::UTF8)
                    for ($i = 0; $i -lt $lines.Length; $i++) {
                        if ($lines[$i] -like 'new file mode*') {
                            for ($j = $i; $j -lt [Math]::Min($i + 6, $lines.Length); $j++) {
                                if ($lines[$j] -like '+++ b/*') { $created += $lines[$j].Substring(6).Trim(); break }
                            }
                        }
                    }
                }
                $removedNew = 0
                foreach ($rel in ($created | Sort-Object -Unique)) {
                    $abs = Join-Path $SrcDir ($rel -replace '/', '\')
                    if (Test-Path $abs) { [System.IO.File]::Delete($abs); $removedNew++ }
                }
                Info "tree reset (-Force); removed $(@($untracked).Count) artifact(s) and $removedNew patch-created file(s)"
            } finally { Pop-Location }
        }
        Push-Location $SrcDir
        try {
            foreach ($p in $series) {
                $full = Join-Path $Here "patches\$p"
                if (-not (Test-Path $full)) { Die "series patch is missing: $p" }
                # --forward prevents an accidental reversal. Every non-zero result is still a hard
                # failure: parsing human-readable output cannot prove that every hunk was already
                # applied, and accepting a partial apply would produce an untrustworthy binary.
                $out = & $patchExe -p1 --forward --batch --no-backup-if-mismatch -i $full 2>&1 | Out-String
                if ($LASTEXITCODE -eq 0) {
                    Ok $p
                } else {
                    Write-Host "    FAIL $p" -ForegroundColor Red
                    ($out -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 12) |
                        ForEach-Object { Write-Host "         $($_.Trim())" -ForegroundColor Red }
                    Die "Patch $p did not apply cleanly. Use -Force for a full reset, or refresh it against $ChromiumRef."
                }
            }
        } finally { Pop-Location }
    } else {
        Plan "patch -p1 --forward each of the $($series.Count) patches, in series order"
    }
}

# --------------------------------------------------------------------------------------------
# 2b. Stage Lobium branding into the checkout.
#
# Runs AFTER the patch step (and after -Force's `git checkout -- .` tree reset) and BEFORE gn gen, so
# nothing can revert it. The stager is deterministic and Playwright-free: it mirrors the committed
# lobium/branding/overlay (product_logo_* rasters + the Windows chrome.ico), copies the Lobium
# BRANDING over chrome/app/theme/chromium/BRANDING (so version_info compiles "Lobium"), applies the
# product-name string transforms (incl. components/components_chromium_strings.grd), and stages the
# NTP icon PNGs. Without this, a clean checkout + build shipped stock Chromium branding.
if (ShouldRun 'patch') {
    Step '2b. Stage Lobium branding (overlay + BRANDING + strings + NTP icons)'
    $stager = Join-Path $Here 'stage-branding.mjs'
    if (-not (Test-Path $stager)) { Die "missing $stager" }
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
    if (-not $node) { Die 'node is not on PATH - required to stage branding.' }
    if ($Run) {
        & $node $stager $SrcDir
        if ($LASTEXITCODE -ne 0) { Die "branding staging failed (exit $LASTEXITCODE)" }
        Ok 'Lobium branding staged'
    } else {
        Plan "node lobium\stage-branding.mjs $SrcDir"
    }
}

# --------------------------------------------------------------------------------------------
if (ShouldRun 'gen') {
    Step '3. gn gen'
    $argsFile = Join-Path $Here 'gn-args-windows.gn'
    if (-not (Test-Path $argsFile)) { Die "missing $argsFile" }
    # Write args.gn into the out dir instead of passing --args=... on the command line.
    #
    # `gn gen <dir> --args="..."` is unusable from PowerShell here: the args string contains
    # double-quoted GN string values (target_cpu = "x64"), and the PowerShell -> cmd.exe (gn.bat)
    # -> gn.exe hop strips those quotes, so GN sees `target_cpu = x64` and dies with "Undefined
    # identifier". args.gn is GN's own canonical mechanism, needs no quoting, and leaves the exact
    # configuration on disk next to the build for anyone auditing what was compiled.
    $outAbs = Join-Path $SrcDir $OutDir
    if ($Run) {
        New-Item -ItemType Directory -Force $outAbs | Out-Null
        Copy-Item $argsFile (Join-Path $outAbs 'args.gn') -Force
        Ok "wrote $OutDir\args.gn"
        Push-Location $SrcDir
        try {
            & gn.bat gen $OutDir
            if ($LASTEXITCODE -ne 0) { Die "gn gen failed (exit $LASTEXITCODE)" }
        } finally { Pop-Location }
        Ok "generated $OutDir"
    } else {
        Plan "copy gn-args-windows.gn to $OutDir\args.gn, then: gn gen $OutDir"
    }
}

# --------------------------------------------------------------------------------------------
if (ShouldRun 'build') {
    Step "4. Build ($Targets)"
    if ($Run) {
        Push-Location $SrcDir
        try {
            $started = Get-Date
            $ninjaArgs = @('-C', $OutDir)
            if ($Jobs -gt 0) { $ninjaArgs += @('-j', $Jobs) }
            & autoninja.bat @ninjaArgs $Targets.Split(' ')
            if ($LASTEXITCODE -ne 0) { Die "build failed (exit $LASTEXITCODE)" }
            Ok ("built in {0:hh\:mm\:ss}" -f ((Get-Date) - $started))
        } finally { Pop-Location }
        $exe = Join-Path $SrcDir (Join-Path $OutDir 'chrome.exe')
        if (Test-Path $exe) {
            Write-Host ''
            Write-Host ('  engine: {0}  ({1:N1} MB)' -f $exe, ((Get-Item $exe).Length / 1MB)) -ForegroundColor Green
        }
    } else {
        Plan ("autoninja -C $OutDir" + $(if ($Jobs -gt 0) { " -j $Jobs" } else { '' }) + " $Targets")
    }
}

Write-Host ''
if (-not $Run) { Write-Host 'DRY RUN complete - nothing was executed.' -ForegroundColor Yellow }
