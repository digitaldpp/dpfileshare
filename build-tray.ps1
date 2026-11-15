# Builds the tray icon program ("DP File Share.exe") with the C# compiler that comes with Windows.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'Could not find the .NET Framework C# compiler (csc.exe).' }

& $csc /nologo /target:winexe /optimize+ "/out:$here\DP File Share.exe" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll "$here\tray\Tray.cs"
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host "Built $here\DP File Share.exe"
