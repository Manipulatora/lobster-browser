<#
.SYNOPSIS
  Generate the NSIS installer artwork from the brand masters.

.DESCRIPTION
  Produces the two bitmaps the Windows installer wizard displays:

    installer-sidebar.bmp   164 x 314   welcome + finish pages (the tall panel on the left)
    installer-header.bmp    150 x  57   every other page (the strip in the top-right)

  WHY BMP, AND WHY 24-BIT. NSIS MUI2 loads these through the Win32 image list, which takes a
  device-independent bitmap and nothing else — a PNG silently renders as nothing at all. 24-bit
  specifically: MUI composites the sidebar against the page background itself, and a 32-bit BMP's
  alpha channel is read as garbage by the classic control, producing a black box. So the alpha is
  flattened here, against the exact colour that will sit behind it.

  WHY THE HEADER IS LIGHT AND THE SIDEBAR IS DARK. MUI draws the page title and subtitle as black
  text on the header's own background, and the header bitmap only occupies the right-hand end of
  that strip. A dark header image therefore looks like a mistake next to black text on white. The
  sidebar has no text over it, so it can carry the full brand treatment.

  Regenerating is a re-run: everything derives from src/assets/brand/_masters, so the art tracks
  the brand rather than being hand-edited pixels nobody can reproduce.
#>

[CmdletBinding()]
param(
  [string]$Root,
  # Also emit PNG copies so the result can actually be looked at; BMP is awkward to preview.
  [switch]$Preview
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Resolved here rather than as a parameter default: $PSScriptRoot is not yet bound when default
# expressions are evaluated under `powershell -File`, so the default silently became empty.
if (-not $Root) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path $MyInvocation.MyCommand.Path -Parent }
  $Root = Split-Path $scriptDir -Parent
}

$masters = Join-Path $Root 'apps/desktop/src/assets/brand/_masters'
$outDir = Join-Path $Root 'apps/desktop/src-tauri/installer'
$markPath = Join-Path $masters 'icon.png'
$lockupPath = Join-Path $masters 'site-logo.png'

foreach ($p in @($markPath, $lockupPath)) {
  if (-not (Test-Path $p)) { throw "brand master not found: $p" }
}
New-Item -ItemType Directory -Force $outDir | Out-Null

# --- Brand palette ------------------------------------------------------------
# Mirrors apps/desktop/src/ui/tokens.css. Restated rather than parsed: this script must not fail
# because a CSS file was reformatted, and these five values change roughly never.
$inkDeep = [System.Drawing.Color]::FromArgb(255, 14, 6, 26)    # near-black violet
$brand800 = [System.Drawing.Color]::FromArgb(255, 76, 29, 149)  # --brand-800
$brand500 = [System.Drawing.Color]::FromArgb(255, 124, 58, 237) # --brand-500, primary violet
$white = [System.Drawing.Color]::White

function New-Canvas {
  param([int]$Width, [int]$Height)
  # Format24bppRgb from the start: creating 32bpp and converting on save leaves a premultiplied
  # alpha channel behind that the BMP encoder writes as-is.
  $bmp = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  return @{ Bitmap = $bmp; Graphics = $g }
}

<#
  Draw an image scaled to fit a box, preserving aspect ratio and centring it.
  Returns the rectangle actually drawn, so callers can position things relative to it.
#>
function Draw-Contained {
  param(
    [System.Drawing.Graphics]$G,
    [System.Drawing.Image]$Image,
    [double]$BoxX, [double]$BoxY, [double]$BoxW, [double]$BoxH
  )
  $scale = [Math]::Min($BoxW / $Image.Width, $BoxH / $Image.Height)
  $w = $Image.Width * $scale
  $h = $Image.Height * $scale
  $x = $BoxX + ($BoxW - $w) / 2
  $y = $BoxY + ($BoxH - $h) / 2
  $G.DrawImage($Image, [float]$x, [float]$y, [float]$w, [float]$h)
  return @{ X = $x; Y = $y; W = $w; H = $h }
}

# ==============================================================================
# SIDEBAR — 164 x 314
# ==============================================================================
function Build-Sidebar {
  $W = 164; $H = 314
  $c = New-Canvas -Width $W -Height $H
  $g = $c.Graphics

  # Vertical gradient, and the stops are placed deliberately rather than evenly.
  #
  # THE FIRST ATTEMPT PUT THE MARK ON VIOLET AND THE MARK VANISHED. The logo is itself violet, so a
  # diagonal ramp that had already reached mid-violet by the mark's centre left almost no contrast —
  # a shield-shaped smudge. The dark end is now held until 52%, which is below the mark, so the
  # logo's light edges sit against near-black and the brand colour still carries the lower half.
  $rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect, $inkDeep, $brand800, [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend(4)
  $blend.Colors = @(
    [System.Drawing.Color]::FromArgb(255, 8, 3, 16),   # near-black at the very top
    [System.Drawing.Color]::FromArgb(255, 18, 8, 36),  # still dark where the mark sits
    [System.Drawing.Color]::FromArgb(255, 58, 22, 122),
    $brand500
  )
  $blend.Positions = @(0.0, 0.52, 0.82, 1.0)
  $grad.InterpolationColors = $blend
  $g.FillRectangle($grad, $rect)
  $grad.Dispose()

  # Bloom behind the mark. Violet, and kept dim: its job is to separate the logo from the panel, not
  # to light it. Concentric translucent discs because GDI+ has no radial brush with a falloff curve.
  $cx = $W / 2.0; $cy = 116.0
  for ($r = 86; $r -gt 0; $r -= 2) {
    $t = 1.0 - ($r / 86.0)
    $alpha = [int]([Math]::Pow($t, 2.4) * 40)
    if ($alpha -le 0) { continue }
    $glow = New-Object System.Drawing.SolidBrush(
      [System.Drawing.Color]::FromArgb($alpha, $brand500.R, $brand500.G, $brand500.B))
    $g.FillEllipse($glow, [float]($cx - $r), [float]($cy - $r), [float]($r * 2), [float]($r * 2))
    $glow.Dispose()
  }

  # A diagonal sheen across the upper panel — the "shimmer". Drawn as a rotated gradient band that
  # is transparent at both ends, so it reads as a glancing highlight rather than a stripe with two
  # visible edges.
  $sheenPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $sheenPath.AddPolygon(@(
      (New-Object System.Drawing.PointF(-40, 214)),
      (New-Object System.Drawing.PointF(96, -40)),
      (New-Object System.Drawing.PointF(168, -40)),
      (New-Object System.Drawing.PointF(32, 214))
    ))
  $sheenRect = New-Object System.Drawing.Rectangle(-40, -40, 210, 260)
  $sheen = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $sheenRect,
    [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
    [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
  # Five stops, with zero alpha held across the outer third at BOTH ends.
  #
  # A three-stop 0 -> peak -> 0 ramp looked right in principle and produced a visible diagonal seam:
  # the gradient's axis is the bounding rectangle's diagonal, which is not the polygon's own
  # diagonal, so one end of the band was still partly opaque where the polygon edge cut it off.
  # Holding transparency well inside the shape means the highlight fades out before any edge,
  # whatever the axis does.
  $sheenBlend = New-Object System.Drawing.Drawing2D.ColorBlend(5)
  $sheenBlend.Colors = @(
    [System.Drawing.Color]::FromArgb(0, 216, 200, 255),
    [System.Drawing.Color]::FromArgb(0, 216, 200, 255),
    [System.Drawing.Color]::FromArgb(24, 216, 200, 255),
    [System.Drawing.Color]::FromArgb(0, 216, 200, 255),
    [System.Drawing.Color]::FromArgb(0, 216, 200, 255)
  )
  $sheenBlend.Positions = @(0.0, 0.30, 0.5, 0.70, 1.0)
  $sheen.InterpolationColors = $sheenBlend
  $g.FillPath($sheen, $sheenPath)
  $sheen.Dispose(); $sheenPath.Dispose()

  # Vignette: darken the outer edges so the panel has a soft frame and the eye lands centre.
  for ($i = 0; $i -lt 18; $i++) {
    $a = [int](3 + $i * 0.9)
    $edge = New-Object System.Drawing.Pen(
      [System.Drawing.Color]::FromArgb($a, 0, 0, 0), 1)
    $g.DrawRectangle($edge, $i, $i, $W - 1 - ($i * 2), $H - 1 - ($i * 2))
    $edge.Dispose()
  }

  # The mark. 2048px master scaled down in one step with bicubic — the detail holds at 108px.
  $mark = [System.Drawing.Image]::FromFile($markPath)
  try {
    [void](Draw-Contained -G $g -Image $mark -BoxX 28 -BoxY 62 -BoxW 108 -BoxH 108)
  } finally { $mark.Dispose() }

  # Wordmark, set rather than scaled from the lockup: the lockup's ink is dark (it is drawn for
  # light backgrounds) and inverting it produces muddy edges at this size.
  $nameFont = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $subFont = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $centre = New-Object System.Drawing.StringFormat
  $centre.Alignment = [System.Drawing.StringAlignment]::Center

  $wordBrush = New-Object System.Drawing.SolidBrush($white)
  $g.DrawString('Lobster Browser', $nameFont, $wordBrush, [float]($W / 2), 188, $centre)

  # A short rule between name and tagline, rather than stranded near the foot where it left the
  # lower third looking unfinished. Here it does actual work: it groups the lockup.
  $ruleY = 212
  $ruleW = 36
  $rulePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(110, 196, 181, 253), 1)
  $g.DrawLine($rulePen, [float](($W - $ruleW) / 2), [float]$ruleY, [float](($W + $ruleW) / 2), [float]$ruleY)
  $rulePen.Dispose()

  # Tagline at 60% white: present, but clearly secondary to the product name.
  $subBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(153, 255, 255, 255))
  $g.DrawString('Anti-detect browser', $subFont, $subBrush, [float]($W / 2), 224, $centre)

  foreach ($d in @($nameFont, $subFont, $wordBrush, $subBrush, $centre)) { $d.Dispose() }
  return $c
}

# ==============================================================================
# HEADER — 150 x 57
# ==============================================================================
function Build-Header {
  $W = 150; $H = 57
  $c = New-Canvas -Width $W -Height $H
  $g = $c.Graphics

  # White, to sit flush with MUI's own header strip. Any other colour leaves a visible seam beside
  # the black page title.
  $g.Clear($white)

  # The real brand lockup (mark + wordmark), dark ink on white — exactly what it was drawn for.
  # Inset so it never touches the edge of the strip.
  $lockup = [System.Drawing.Image]::FromFile($lockupPath)
  try {
    [void](Draw-Contained -G $g -Image $lockup -BoxX 10 -BoxY 8 -BoxW ($W - 20) -BoxH ($H - 16))
  } finally { $lockup.Dispose() }

  return $c
}

# --- Emit ---------------------------------------------------------------------
function Save-Art {
  param($Canvas, [string]$Name)
  $bmpPath = Join-Path $outDir "$Name.bmp"
  $Canvas.Graphics.Dispose()
  $Canvas.Bitmap.Save($bmpPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
  if ($Preview) {
    $Canvas.Bitmap.Save((Join-Path $outDir "$Name.preview.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $size = (Get-Item $bmpPath).Length
  Write-Host ("  {0,-24} {1}x{2}  {3:N0} bytes" -f "$Name.bmp", $Canvas.Bitmap.Width, $Canvas.Bitmap.Height, $size)
  $Canvas.Bitmap.Dispose()
}

Write-Host '[installer-art] generating from brand masters...'
Save-Art -Canvas (Build-Sidebar) -Name 'installer-sidebar'
Save-Art -Canvas (Build-Header) -Name 'installer-header'
Write-Host "[installer-art] done -> $outDir"
