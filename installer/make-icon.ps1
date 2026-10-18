# Generates app.ico (the application icon) from code, so it can be regenerated or tweaked without a graphics editor.
# Usage:  .\installer\make-icon.ps1 [-Out path\to\app.ico] [-Preview path\to\preview.png]
#
# The artwork is original: a blue rounded square, a white cartoon whale and a terminal prompt (">_") inside it.
# It is deliberately NOT DeepSeek's logo; do not replace it with their artwork.
param(
    [string]$Out = (Join-Path (Split-Path -Parent $PSScriptRoot) 'app.ico'),
    [string]$Preview
)

Add-Type -AssemblyName System.Drawing

function Add-WhaleShape($g, [single]$x0, [single]$y0, [single]$w, [single]$h, $brush, $eyeColor) {
    function P([single]$nx, [single]$ny) { return New-Object System.Drawing.PointF ($x0 + $nx * $w), ($y0 + $ny * $h) }
    # tail with two lobes, then the body, an eye and a two-jet spout
    $tail = @((P 0.22 0.62), (P 0.10 0.56), (P 0.00 0.38), (P 0.15 0.44), (P 0.10 0.22), (P 0.30 0.48))
    $g.FillPolygon($brush, [System.Drawing.PointF[]]$tail)
    $g.FillEllipse($brush, ($x0 + 0.14 * $w), ($y0 + 0.30 * $h), (0.86 * $w), (0.62 * $h))
    $r = [single]([math]::Max(0.9, 0.035 * $w))
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $eyeColor), ($x0 + 0.80 * $w - $r), ($y0 + 0.52 * $h - $r), (2 * $r), (2 * $r))
    $pen = New-Object System.Drawing.Pen $brush, ([single]([math]::Max(1.2, 0.045 * $w)))
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    $g.DrawBezier($pen, (P 0.66 0.30), (P 0.66 0.16), (P 0.58 0.10), (P 0.52 0.12))
    $g.DrawBezier($pen, (P 0.70 0.30), (P 0.70 0.16), (P 0.78 0.08), (P 0.86 0.12))
}

function New-Frame([int]$S) {
    $bmp = New-Object System.Drawing.Bitmap $S, $S, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded square with a blue gradient around #4D6BFE
    $r = [single]($S * 0.22); $m = [single]($S * 0.04); $w = [single]($S - 2 * $m); $d = $r * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($m, $m, $d, $d, 180, 90)
    $path.AddArc($m + $w - $d, $m, $d, $d, 270, 90)
    $path.AddArc($m + $w - $d, $m + $w - $d, $d, $d, 0, 90)
    $path.AddArc($m, $m + $w - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $rect = New-Object System.Drawing.RectangleF 0, 0, $S, $S
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 99, 128, 255)), ([System.Drawing.Color]::FromArgb(255, 60, 88, 240)), 55
    $g.FillPath($grad, $path)

    # White whale with the terminal prompt cut out of its body in blue
    $blue = [System.Drawing.Color]::FromArgb(255, 70, 100, 245)
    Add-WhaleShape $g ($S * 0.10) ($S * 0.20) ($S * 0.82) ($S * 0.62) ([System.Drawing.Brushes]::White) $blue
    $font = New-Object System.Drawing.Font 'Consolas', ([single]($S * 0.22)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
    $box = New-Object System.Drawing.RectangleF ($S * 0.36), ($S * 0.40), ($S * 0.36), ($S * 0.30)
    $g.DrawString('>_', $font, (New-Object System.Drawing.SolidBrush $blue), $box, $fmt)

    $g.Dispose()
    return $bmp
}

# Classic 32-bit DIB frame (what Windows expects below 256 px): BITMAPINFOHEADER with doubled height,
# bottom-up BGRA pixels, then a 1-bit AND mask (all zero; the alpha channel does the transparency).
function Get-DibBytes($bmp) {
    $W = $bmp.Width; $H = $bmp.Height
    $rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $raw = New-Object byte[] ($stride * $H)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
    $bmp.UnlockBits($data)

    $maskStride = [int]([math]::Ceiling($W / 32.0) * 4)
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $ms
    $bw.Write([uint32]40); $bw.Write([int32]$W); $bw.Write([int32]($H * 2))
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]0)
    $bw.Write([uint32]($W * $H * 4 + $maskStride * $H))
    $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
    for ($y = $H - 1; $y -ge 0; $y--) { $bw.Write($raw, $y * $stride, $W * 4) }
    $bw.Write((New-Object byte[] ($maskStride * $H)))
    $bw.Flush()
    return , $ms.ToArray()   # the leading comma keeps it a byte[] instead of unrolling it
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$frames = @()
foreach ($s in $sizes) {
    $bmp = New-Frame $s
    if ($s -ge 256) {
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $frames += , $ms.ToArray()
        if ($Preview) { $bmp.Save($Preview, [System.Drawing.Imaging.ImageFormat]::Png) }
    } else {
        [byte[]]$dib = Get-DibBytes $bmp
        $frames += , $dib
    }
    $bmp.Dispose()
}

# ICO container: DIB frames below 256 px and a PNG frame for 256 px (the standard layout).
$fs = [System.IO.File]::Create($Out)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $dim = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$frames[$i].Length); $bw.Write([uint32]$offset)
    $offset += $frames[$i].Length
}
foreach ($f in $frames) { $bw.Write($f) }
$bw.Close(); $fs.Close()
"icon written: $Out ($([math]::Round((Get-Item $Out).Length / 1KB)) KB, $($sizes.Count) sizes)"
