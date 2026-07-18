$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Payload = Join-Path $Root 'dist\payload'
Remove-Item (Join-Path $Root 'dist') -Recurse -Force -ErrorAction SilentlyContinue
New-Item (Join-Path $Payload 'app\data') -ItemType Directory -Force | Out-Null
New-Item (Join-Path $Payload 'app\assets') -ItemType Directory -Force | Out-Null
New-Item (Join-Path $Payload 'app\node_modules') -ItemType Directory -Force | Out-Null
New-Item (Join-Path $Payload 'app\web') -ItemType Directory -Force | Out-Null
New-Item (Join-Path $Payload 'runtime') -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $Root 'app\app.js') (Join-Path $Payload 'app\app.js')
Copy-Item (Join-Path $Root 'app\verify.js') (Join-Path $Payload 'app\verify.js')
Copy-Item (Join-Path $Root 'app\web\index.html') (Join-Path $Payload 'app\web\index.html')
Copy-Item (Join-Path $Root 'app\data\*.json') (Join-Path $Payload 'app\data')
[System.IO.File]::WriteAllBytes((Join-Path $Payload 'app\assets\ZIENTSOV_LATYNKA.ico'), [System.Convert]::FromBase64String((Get-Content (Join-Path $Root 'app\assets\ZIENTSOV_LATYNKA.ico.b64') -Raw)))
Add-Type -AssemblyName System.Drawing
$SidebarPath = Join-Path $Root 'dist\installer-sidebar.bmp'
$Sidebar = [System.Drawing.Bitmap]::new(164, 314)
$Canvas = [System.Drawing.Graphics]::FromImage($Sidebar)
$Canvas.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$Gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Point]::new(0, 0),
  [System.Drawing.Point]::new(164, 314),
  [System.Drawing.Color]::FromArgb(20, 55, 137),
  [System.Drawing.Color]::FromArgb(27, 104, 238)
)
$Canvas.FillRectangle($Gradient, 0, 0, 164, 314)
$BrandIcon = [System.Drawing.Icon]::new((Join-Path $Payload 'app\assets\ZIENTSOV_LATYNKA.ico'), 96, 96)
$Canvas.DrawIcon($BrandIcon, 34, 38)
$TitleFont = [System.Drawing.Font]::new('Segoe UI', 15, [System.Drawing.FontStyle]::Bold)
$CaptionFont = [System.Drawing.Font]::new('Segoe UI', 8.5, [System.Drawing.FontStyle]::Regular)
$Centered = [System.Drawing.StringFormat]::new()
$Centered.Alignment = [System.Drawing.StringAlignment]::Center
$Canvas.DrawString('ZIENTSOV', $TitleFont, [System.Drawing.Brushes]::White, [System.Drawing.RectangleF]::new(0, 157, 164, 27), $Centered)
$Canvas.DrawString('LATYNKA', $TitleFont, [System.Drawing.Brushes]::White, [System.Drawing.RectangleF]::new(0, 183, 164, 27), $Centered)
$Canvas.DrawString('Український словник', $CaptionFont, [System.Drawing.Brushes]::White, [System.Drawing.RectangleF]::new(0, 224, 164, 20), $Centered)
$Canvas.FillRectangle([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 216, 77)), 0, 274, 164, 40)
$Canvas.DrawString('UA', $TitleFont, [System.Drawing.Brushes]::MidnightBlue, [System.Drawing.RectangleF]::new(0, 281, 164, 27), $Centered)
$Sidebar.Save($SidebarPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
$BrandIcon.Dispose(); $TitleFont.Dispose(); $CaptionFont.Dispose(); $Centered.Dispose(); $Gradient.Dispose(); $Canvas.Dispose(); $Sidebar.Dispose()
$Csc = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Csc) { throw 'Не знайдено компілятор нативного Windows-запускника.' }
$LauncherOutput = Join-Path $Payload 'ZIENTSOV_LATYNKA.exe'
& $Csc /nologo /target:winexe /optimize+ /platform:anycpu /reference:System.Windows.Forms.dll "/win32icon:$(Join-Path $Payload 'app\assets\ZIENTSOV_LATYNKA.ico')" "/out:$LauncherOutput" (Join-Path $Root 'launcher\Program.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $LauncherOutput)) { throw 'Не вдалося створити нативний Windows-запускник.' }
Copy-Item (Get-Command node.exe).Source (Join-Path $Payload 'runtime\node.exe')
Copy-Item (Join-Path $Root 'node_modules\nspell') (Join-Path $Payload 'app\node_modules\nspell') -Recurse
Copy-Item (Join-Path $Root 'node_modules\is-buffer') (Join-Path $Payload 'app\node_modules\is-buffer') -Recurse
node (Join-Path $Root 'build_dictionary.js')
Write-Host 'Пакет для інсталятора підготовлено.'
