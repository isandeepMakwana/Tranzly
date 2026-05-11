$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$iconDir = Join-Path $root "icons"
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

$states = @{
  idle = @{
    Fill = "#2563EB"
  }
}

$sizes = @(16, 32, 48, 128)

function Convert-HexColor($hex) {
  $value = $hex.TrimStart("#")
  $r = [Convert]::ToInt32($value.Substring(0, 2), 16)
  $g = [Convert]::ToInt32($value.Substring(2, 2), 16)
  $b = [Convert]::ToInt32($value.Substring(4, 2), 16)
  return [System.Drawing.Color]::FromArgb(255, $r, $g, $b)
}

function New-RoundedRectanglePath($rect, $radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-CenteredText($graphics, $text, $font, $brush, $rect) {
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $graphics.DrawString($text, $font, $brush, $rect, $format)
  $format.Dispose()
}

foreach ($stateName in $states.Keys) {
  foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $scale = $size / 128.0
    $rect = [System.Drawing.RectangleF]::new([float](8 * $scale), [float](8 * $scale), [float](112 * $scale), [float](112 * $scale))
    $radius = [Math]::Max(3, 20 * $scale)
    $path = New-RoundedRectanglePath $rect $radius

    $fill = Convert-HexColor $states[$stateName].Fill
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $fill, [System.Drawing.Color]::FromArgb(255, 96, 165, 250), [float]45)
    $graphics.FillPath($brush, $path)

    $shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(50, 15, 23, 42))
    $shadowRect = [System.Drawing.RectangleF]::new([float](46 * $scale), [float](64 * $scale), [float](58 * $scale), [float](42 * $scale))
    $shadowPath = New-RoundedRectanglePath $shadowRect ([Math]::Max(2, 8 * $scale))
    $graphics.FillPath($shadowBrush, $shadowPath)

    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 55, 65, 81))
    $fontFamily = [System.Drawing.FontFamily]::new("Segoe UI")
    $fontCulture = [System.Drawing.Font]::new($fontFamily, [float]([Math]::Max(7, 54 * $scale)), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fontA = [System.Drawing.Font]::new($fontFamily, [float]([Math]::Max(6, 34 * $scale)), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)

    Draw-CenteredText $graphics ([string][char]0x6587) $fontCulture $white ([System.Drawing.RectangleF]::new([float](14 * $scale), [float](20 * $scale), [float](66 * $scale), [float](74 * $scale)))

    $paperRect = [System.Drawing.RectangleF]::new([float](68 * $scale), [float](50 * $scale), [float](42 * $scale), [float](44 * $scale))
    $paperPath = New-RoundedRectanglePath $paperRect ([Math]::Max(2, 7 * $scale))
    $paperBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245, 255, 255, 255))
    $graphics.FillPath($paperBrush, $paperPath)
    Draw-CenteredText $graphics "A" $fontA $dark $paperRect

    $file = Join-Path $iconDir "$stateName-$size.png"
    $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)

    $graphics.Dispose()
    $bitmap.Dispose()
    $path.Dispose()
    $brush.Dispose()
    $shadowBrush.Dispose()
    $shadowPath.Dispose()
    $white.Dispose()
    $dark.Dispose()
    $fontCulture.Dispose()
    $fontA.Dispose()
    $fontFamily.Dispose()
    $paperBrush.Dispose()
    $paperPath.Dispose()
  }
}
