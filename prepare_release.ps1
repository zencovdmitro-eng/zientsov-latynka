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
$Launcher = @'
Option Explicit
Dim shell, files, root, nodeExe, appJs
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
nodeExe = root & "\runtime\node.exe"
appJs = root & "\app\app.js"
If Not files.FileExists(nodeExe) Or Not files.FileExists(appJs) Then WScript.Quit 1
shell.Run Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & appJs & Chr(34), 0, False
'@
[System.IO.File]::WriteAllText((Join-Path $Payload 'START_ZIENTSOV_LATYNKA.vbs'), $Launcher, [System.Text.Encoding]::Unicode)
Copy-Item (Get-Command node.exe).Source (Join-Path $Payload 'runtime\node.exe')
Copy-Item (Join-Path $Root 'node_modules\nspell') (Join-Path $Payload 'app\node_modules\nspell') -Recurse
Copy-Item (Join-Path $Root 'node_modules\is-buffer') (Join-Path $Payload 'app\node_modules\is-buffer') -Recurse
node (Join-Path $Root 'build_dictionary.js')
Write-Host 'Пакет для інсталятора підготовлено.'
