<#
.SYNOPSIS
  Assert that a built Windows installer is actually production-shaped.

.DESCRIPTION
  Checks the things that are invisible until a user is already looking at them: the version and
  publisher Windows shows in Add/Remove Programs and the SmartScreen dialog, whether the binary is
  signed, and whether the branded bitmaps really made it into the package.

  Written because every one of these has a silent-failure mode. A missing `publisher` shows as
  "Unknown publisher" only in the UAC/SmartScreen dialog. A `headerImage` path that does not resolve
  is not a build error - NSIS just renders the default. `version` defaults to 0.0.0 and looks like a
  broken install rather than a missing config line.

.EXAMPLE
  powershell -File scripts/verify-installer.ps1 -Path C:\production\Lobster-Browser_1.0.0_x64-setup.exe
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Path,
  [string]$ExpectedVersion,
  # Where the bundler left `installer.nsi`. Read for the settings that LZMA compression makes
  # unverifiable from the .exe itself; see the note above that section.
  [string]$NsisScriptDir = 'apps/desktop/src-tauri/target/release/nsis/x64'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Path)) { throw "installer not found: $Path" }

$failures = 0
function Check {
  param([string]$Label, [bool]$Ok, [string]$Detail = '')
  if ($Ok) { Write-Host ("  PASS  {0}{1}" -f $Label, $(if ($Detail) { " - $Detail" } else { '' })) }
  else { $script:failures++; Write-Host ("  FAIL  {0}{1}" -f $Label, $(if ($Detail) { " - $Detail" } else { '' })) }
}

$file = Get-Item $Path
$sizeMb = [math]::Round($file.Length / 1MB, 1)
Write-Host "`n$($file.Name)  -  $sizeMb MB`n"

# --- Version resource ---------------------------------------------------------
$vi = $file.VersionInfo
Write-Host 'Version resource:'
Write-Host ("  ProductName      {0}" -f $vi.ProductName)
Write-Host ("  ProductVersion   {0}" -f $vi.ProductVersion)
Write-Host ("  FileVersion      {0}" -f $vi.FileVersion)
Write-Host ("  CompanyName      {0}" -f $vi.CompanyName)
Write-Host ("  FileDescription  {0}" -f $vi.FileDescription)
Write-Host ("  LegalCopyright   {0}" -f $vi.LegalCopyright)
Write-Host ''

Write-Host 'Assertions:'
Check 'version is not the 0.0.0 placeholder' ($vi.ProductVersion -notmatch '^0\.0\.0')  $vi.ProductVersion
if ($ExpectedVersion) {
  Check "version is $ExpectedVersion" ($vi.ProductVersion -like "$ExpectedVersion*") $vi.ProductVersion
}
Check 'copyright is set' (-not [string]::IsNullOrWhiteSpace($vi.LegalCopyright))

# CompanyName is a WARN, not a FAIL, and the distinction is the point.
#
# Tauri's stock NSIS template emits ProductName, FileDescription, LegalCopyright, FileVersion and
# ProductVersion - but never `VIAddVersionKey "CompanyName"`. So `bundle.publisher` cannot reach
# this field however it is configured; only a custom NSIS template can set it. What publisher
# actually drives is the Add/Remove Programs entry, which IS checked below, and the SmartScreen
# publisher line, which comes from the code signature rather than from here. The visible cost of
# leaving it empty is a blank "Company" row in the file's Properties dialog.
if ([string]::IsNullOrWhiteSpace($vi.CompanyName)) {
  Write-Host '  WARN  CompanyName empty in the version resource (Tauri template omits it).'
  Write-Host '        Cosmetic: affects only the .exe Properties dialog. Needs a custom NSIS template.'
} else {
  Check 'CompanyName set' $true $vi.CompanyName
}

# --- Authenticode -------------------------------------------------------------
$sig = Get-AuthenticodeSignature -FilePath $Path
if ($sig.Status -eq 'Valid') {
  Check 'code signature valid' $true $sig.SignerCertificate.Subject
} else {
  # Not counted as a failure: it is a known, documented gap that needs a purchased certificate.
  # Reported loudly because it is the single most visible production defect for a Windows user.
  Write-Host ("  WARN  UNSIGNED ({0}) - SmartScreen will warn every first-time user." -f $sig.Status)
  Write-Host '        Needs an Authenticode certificate; see src-tauri/installer/README.md.'
}

# --- Wizard configuration, from the generated NSIS script ---------------------
#
# THE FIRST VERSION OF THIS SECTION SCANNED THE .exe FOR BMP HEADERS AND THE LICENCE TEXT, AND
# REPORTED THREE FALSE FAILURES. The package is built with `SetCompressor /SOLID lzma`, so every
# embedded resource is inside one compressed stream - none of those bytes appear in the file
# literally, and their absence proves nothing at all.
#
# The generated `installer.nsi` is the honest source for these. It records the exact paths the
# bundler resolved, so an unresolved config key shows up as an empty define. A missing FILE would
# additionally have failed the NSIS compile, so "the define points at our file AND the build
# succeeded" is a real end-to-end check.
$nsi = Join-Path $NsisScriptDir 'installer.nsi'
if (-not (Test-Path $nsi)) {
  Write-Host "  SKIP  wizard configuration - no installer.nsi at $nsi"
} else {
  function Get-Define {
    param([string]$Name)
    $m = Select-String -Path $nsi -Pattern ("^!define {0} `"(.*)`"$" -f [regex]::Escape($Name)) | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value }
    return ''
  }

  $sidebar = Get-Define 'SIDEBARIMAGE'
  $header = Get-Define 'HEADERIMAGE'
  $instIcon = Get-Define 'INSTALLERICON'
  $uninstIcon = Get-Define 'UNINSTALLERICON'
  $licence = Get-Define 'LICENSE'
  $mode = Get-Define 'INSTALLMODE'
  $manufacturer = Get-Define 'MANUFACTURER'

  Check 'sidebar bitmap wired'   ($sidebar -like '*installer-sidebar.bmp') $sidebar
  Check 'header bitmap wired'    ($header -like '*installer-header.bmp') $header
  Check 'installer icon wired'   ($instIcon -like '*.ico') $instIcon
  Check 'uninstaller icon wired' ($uninstIcon -like '*.ico') $(if ($uninstIcon) { $uninstIcon } else { '(empty)' })
  Check 'licence page wired'     (-not [string]::IsNullOrWhiteSpace($licence)) $licence
  # currentUser means no UAC prompt during setup.
  Check 'per-user install (no UAC)' ($mode -eq 'currentUser') $mode
  # This is the Publisher that Add/Remove Programs actually displays.
  Check 'publisher in uninstall entry' (-not [string]::IsNullOrWhiteSpace($manufacturer)) $manufacturer
}

Write-Host ''
if ($failures -eq 0) { Write-Host 'ALL CHECKS PASSED'; exit 0 }
Write-Host "$failures CHECK(S) FAILED"; exit 1
