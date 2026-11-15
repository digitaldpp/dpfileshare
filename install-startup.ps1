# Makes the DP File Share tray icon start when you sign in to Windows, and starts it now.
# Sharing stays OFF until you turn it on from the icon. Run with -Remove to undo.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'DP File Share.exe'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

if ($Remove) {
  Remove-ItemProperty -Path $key -Name 'DP File Share' -ErrorAction SilentlyContinue
  Write-Host 'DP File Share will no longer start with Windows.'
  return
}

if (-not (Test-Path $exe)) { & (Join-Path $PSScriptRoot 'build-tray.ps1') }
Set-ItemProperty -Path $key -Name 'DP File Share' -Value "`"$exe`""
Start-Process -FilePath $exe
Write-Host 'DP File Share will start with Windows (sharing off until you turn it on from the tray icon).'
