<#
    Resample the desktop brand PNGs to the size they are actually rendered at.

        powershell -ExecutionPolicy Bypass -File scripts\optimise-brand-images.ps1

    WHY. The originals are print-resolution masters shipped verbatim into the app bundle:
    icon.png is 2048x2048 (1.6 MB) and renders in a 28-32 px box; site-logo.png is 2747x540
    (492 KB) and renders 22 px tall. Together that is ~2.1 MB of the ~5 MB frontend payload,
    decoded on every launch, to paint about 4,000 visible pixels.

    Each target is 4x the largest CSS size it appears at, which covers 200% display scaling with a
    margin and still lands in single-digit KB. Masters stay in git under assets/brand/_masters so a
    future size change is a re-run rather than a re-export.
#>
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$brand = Join-Path $root 'apps\desktop\src\assets\brand'
$masters = Join-Path $brand '_masters'

# name -> target box. Rendered sizes: site-logo 22px tall; icon/lobster-icon in a 28-32px box;
# browser-logo and ad are used by the marketing surfaces at larger sizes.
$targets = @{
    'site-logo.png'    = @{ w = 0;   h = 88  }   # 4x the 22px bar height, width follows aspect
    'icon.png'         = @{ w = 128; h = 128 }   # 4x the 32px preview
    'lobster-icon.png' = @{ w = 128; h = 128 }
    'browser-logo.png' = @{ w = 512; h = 0   }
    'ad.png'           = @{ w = 1200; h = 0  }
}

New-Item -ItemType Directory -Force $masters | Out-Null

$before = 0
$after = 0

foreach ($name in $targets.Keys) {
    $path = Join-Path $brand $name
    if (-not (Test-Path $path)) { Write-Warning "missing: $name"; continue }

    # Keep the master once, then always resample FROM it - re-encoding an already-resampled file
    # compounds resampling artefacts every time this script is run.
    $master = Join-Path $masters $name
    if (-not (Test-Path $master)) { Copy-Item $path $master }

    $src = [System.Drawing.Image]::FromFile($master)
    try {
        $t = $targets[$name]
        $w = $t.w; $h = $t.h
        if ($w -eq 0) { $w = [int][Math]::Round($src.Width * ($h / $src.Height)) }
        if ($h -eq 0) { $h = [int][Math]::Round($src.Height * ($w / $src.Width)) }
        if ($w -ge $src.Width -and $h -ge $src.Height -and -not $Force) {
            Write-Host ("  skip  {0,-18} master is already {1}x{2}" -f $name, $src.Width, $src.Height)
            continue
        }

        $before += (Get-Item $path).Length

        # 32bppArgb preserves the alpha these logos rely on over the dark topbar.
        $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)))
        } finally { $g.Dispose() }

        $tmp = "$path.tmp"
        $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Move-Item $tmp $path -Force

        $newLen = (Get-Item $path).Length
        $after += $newLen
        Write-Host ("  {0,-18} {1,5}x{2,-5} -> {3,4}x{4,-5} {5,7:N0} KB" -f $name, $src.Width, $src.Height, $w, $h, ($newLen / 1KB))
    } finally { $src.Dispose() }
}

if ($before -gt 0) {
    Write-Host ''
    Write-Host ("  total {0:N0} KB -> {1:N0} KB  ({2:N0} KB saved)" -f ($before / 1KB), ($after / 1KB), (($before - $after) / 1KB))
}
