<#
    Compile and run the Lobium kernel property tests.

        powershell -ExecutionPolicy Bypass -File lobium\test\run.ps1

    These compile the SHIPPING kernel sources from lobium/src/ unmodified — the shims under
    test/include/ satisfy their in-tree "components/lobium_fp/..." includes — so the properties are
    checked against real code rather than a re-implementation that could drift.

    No Chromium checkout is required. That is deliberate: every test here is a DETECTION ORACLE a
    page can run in a few lines, so they must be cheap enough to run on every change, not gated
    behind a multi-hour engine build.
#>
[CmdletBinding()]
param(
    # Compiler to use. Defaults to the Chromium tree's clang-cl if present, else any clang/cl on PATH.
    [string] $Compiler
)

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Src = Join-Path (Split-Path -Parent $Here) 'src'
$Out = Join-Path $Here 'out'

function Die([string] $m) { Write-Host "FAILED: $m" -ForegroundColor Red; exit 1 }

if (-not $Compiler) {
    $checkoutCompiler = if ($env:LOBIUM_CHROMIUM_SRC) {
        Join-Path $env:LOBIUM_CHROMIUM_SRC 'third_party\llvm-build\Release+Asserts\bin\clang-cl.exe'
    }
    $candidates = @(
        $checkoutCompiler
    ) + @((Get-Command clang-cl.exe, clang++.exe, cl.exe -ErrorAction SilentlyContinue).Source)
    $Compiler = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $Compiler) { Die 'no C++ compiler found (pass -Compiler, or put clang-cl/cl on PATH)' }
Write-Host "compiler: $Compiler" -ForegroundColor DarkGray

New-Item -ItemType Directory -Force $Out | Out-Null

$suites = @(
    @{ name = 'audio';  test = 'audio_farble_properties.cc';  kernel = 'lobium_audio_farble.cc' },
    @{ name = 'canvas'; test = 'canvas_farble_properties.cc'; kernel = 'lobium_farble.cc' }
)

$failed = 0
foreach ($s in $suites) {
    Write-Host ''
    Write-Host "==> $($s.name)" -ForegroundColor Cyan
    $exe = Join-Path $Out "$($s.name).exe"
    $args = @(
        '/std:c++20', '/O2', '/EHsc', '/nologo', '/W4',
        "/I$(Join-Path $Here 'include')",
        (Join-Path $Here $s.test),
        (Join-Path $Src $s.kernel),
        "/Fe:$exe", "/Fo:$Out\"
    )
    & $Compiler @args 2>&1 | Where-Object { $_ -notmatch '^\s*$' -and $_ -notmatch '\.cc$' }
    if ($LASTEXITCODE -ne 0) { Die "$($s.name): compilation failed" }
    & $exe
    if ($LASTEXITCODE -ne 0) { $failed++ }
}

Write-Host ''
if ($failed) {
    Write-Host "$failed suite(s) FAILED" -ForegroundColor Red
    exit 1
}
Write-Host 'all kernel property suites passed' -ForegroundColor Green
