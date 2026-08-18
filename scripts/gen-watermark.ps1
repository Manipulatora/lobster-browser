# Generate the faint brand watermark used behind the Profiles / Proxies / Templates lists.
#
# Derived from the real brand master (assets/brand/_masters/icon.png, 2048x2048 RGBA) rather than a
# hand-drawn stand-in, so the mark on screen is the product's own lobster.
#
# The output is a FLAT TINT, not a faded copy of the artwork. Fading full-colour art to a few percent
# averages its highlights and shadows toward the page and yields a grey haze with a halo on the
# premultiplied edge pixels. Taking only the master's alpha as a silhouette and painting it in one
# brand colour keeps a clean shape at any opacity.
#
# ALPHA IS A CONTRAST BUDGET, NOT A TASTE. --text-muted (#6b7482) on white is already 4.72:1 against
# a 4.5:1 AA floor, so the composited background may lose only ~5% relative luminance. Brand violet
# #7c3aed at 0.03 lands on #fbf9fe (4.52:1, passes); 0.04 gives 4.45:1 and fails. Do not raise ALPHA
# without re-deriving that number.
#
# Usage:  powershell -NoProfile -File scripts/gen-watermark.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repo 'apps\desktop\src\assets\brand\_masters\icon.png'
$outPng = Join-Path $repo 'apps\desktop\src\assets\brand\watermark.png'

# 900px: the CSS caps the mark at 620 CSS px and this audience runs Windows at 125-150% scaling,
# so 620 * 1.5 = 930 device px is the real ceiling. Generating larger only costs bytes.
$SIZE = 900
$ALPHA = 0.03
$R = 124; $G = 58; $B = 237   # --brand-500 #7c3aed

if (-not (Test-Path $src)) { throw "master not found: $src" }

$master = [System.Drawing.Image]::FromFile($src)
try {
  $canvas = New-Object System.Drawing.Bitmap $SIZE, $SIZE, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gfx = [System.Drawing.Graphics]::FromImage($canvas)
  $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gfx.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $gfx.Clear([System.Drawing.Color]::Transparent)
  $gfx.DrawImage($master, 0, 0, $SIZE, $SIZE)
  $gfx.Dispose()
} finally {
  $master.Dispose()
}

# Repaint every pixel: keep the silhouette from the master's alpha, throw the colour away.
$rect = New-Object System.Drawing.Rectangle 0, 0, $SIZE, $SIZE
$data = $canvas.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$count = $SIZE * $SIZE * 4
$buf = New-Object byte[] $count
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $count)

# Format32bppArgb is B,G,R,A in memory order.
for ($i = 0; $i -lt $count; $i += 4) {
  $a = $buf[$i + 3]
  if ($a -eq 0) { continue }
  $buf[$i] = $B
  $buf[$i + 1] = $G
  $buf[$i + 2] = $R
  $buf[$i + 3] = [byte][Math]::Round($a * $ALPHA)
}

[System.Runtime.InteropServices.Marshal]::Copy($buf, 0, $data.Scan0, $count)
$canvas.UnlockBits($data)
$canvas.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()

$kb = [math]::Round((Get-Item $outPng).Length / 1KB, 1)
Write-Output "[gen-watermark] wrote $outPng  ${SIZE}x${SIZE}  $kb KB"
