# Draws tray\app.ico, the icon of "DP File Share.exe": a green rounded square with "DP".
# The result is committed, so this only needs running if the design changes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-Png([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $d = $size * 0.44
  $e = $size - $d - 1
  $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
  $shape.AddArc(0, 0, $d, $d, 180, 90)
  $shape.AddArc($e, 0, $d, $d, 270, 90)
  $shape.AddArc($e, $e, $d, $d, 0, 90)
  $shape.AddArc(0, $e, $d, $d, 90, 90)
  $shape.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(22, 128, 61))
  $g.FillPath($brush, $shape)
  $font = New-Object System.Drawing.Font 'Segoe UI', ($size * 0.42), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = 'Center'
  $format.LineAlignment = 'Center'
  $box = New-Object System.Drawing.RectangleF 0, ($size / 32), $size, $size
  $g.DrawString('DP', $font, [System.Drawing.Brushes]::White, $box, $format)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  , $ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 256
$images = foreach ($s in $sizes) { , (New-Png $s) }

$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $w.Write([byte]($sizes[$i] % 256)); $w.Write([byte]($sizes[$i] % 256))  # 256 is written as 0
  $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$images[$i].Length); $w.Write([uint32]$offset)
  $offset += $images[$i].Length
}
foreach ($img in $images) { $w.Write($img) }
$w.Flush()
$target = Join-Path (Split-Path $PSScriptRoot -Parent) 'tray\app.ico'
[System.IO.File]::WriteAllBytes($target, $out.ToArray())
Write-Host "Wrote $target"
