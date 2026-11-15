# Builds dist\DP File Share.exe: one file with everything inside. Needs Node.js 20+ and Windows
# (the C# compiler that comes with Windows builds the tray program). Run `npm ci` first.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1
#
# How it fits together:
#   1. server.js and the pages in public\ are packed into a copy of node.exe (a Node "single
#      executable application"). That is the engine: the server, with Node built in.
#   2. The engine is compressed and attached to the end of the tray program, which unpacks and runs it
#      when sharing is turned on.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$work = Join-Path $root 'build'
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $work, $dist | Out-Null
Set-Location $root

function Invoke-Checked([string]$what, [scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)." }
}

$package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $package.version
Write-Host "Building DP File Share $version"

# ---- 1. the engine ----
$engine = Join-Path $work 'dpfs-engine.exe'
$blob = Join-Path $work 'sea-prep.blob'
Invoke-Checked 'Packing the server' { node --experimental-sea-config sea-config.json }
Copy-Item (Get-Command node).Source $engine -Force

# node.exe is signed by the Node.js project. Changing the file breaks that signature, and a
# broken signature looks worse to Windows than none at all, so it is removed first. It lives at
# the end of the file, pointed to by the "security" entry of the header.
$bytes = [System.IO.File]::ReadAllBytes($engine)
$pe = [BitConverter]::ToInt32($bytes, 0x3C)
$magic = [BitConverter]::ToUInt16($bytes, $pe + 24)
$dirs = $pe + 24 + $(if ($magic -eq 0x20B) { 112 } else { 96 })
$security = $dirs + 4 * 8
$sigOffset = [BitConverter]::ToInt32($bytes, $security)
$sigSize = [BitConverter]::ToInt32($bytes, $security + 4)
if ($sigOffset -gt 0 -and ($sigOffset + $sigSize) -eq $bytes.Length) {
  [Array]::Clear($bytes, $security, 8)
  $stream = [System.IO.File]::Create($engine)
  $stream.Write($bytes, 0, $sigOffset)
  $stream.Dispose()
} elseif ($sigOffset -gt 0) {
  Write-Warning 'The signature of node.exe is not where it was expected, so it was left in place.'
}
$bytes = $null

Invoke-Checked 'Adding the server to the engine' {
  node (Join-Path $root 'node_modules\postject\dist\cli.js') $engine NODE_SEA_BLOB $blob `
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite
}

# ---- 2. compress it, and note which build it is so the tray knows when to unpack a new one ----
$packed = Join-Path $work 'engine.gz'
$idFile = Join-Path $work 'engine.id'
$in = [System.IO.File]::OpenRead($engine)
$outFile = [System.IO.File]::Create($packed)
$gzip = New-Object System.IO.Compression.GZipStream $outFile, ([System.IO.Compression.CompressionLevel]::Optimal)
$in.CopyTo($gzip)
$gzip.Dispose(); $outFile.Dispose(); $in.Dispose()
$hash = (Get-FileHash $engine -Algorithm SHA256).Hash.ToLower()
[System.IO.File]::WriteAllText($idFile, "$version-$hash")

# ---- 3. the tray program, with the engine attached ----
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'Could not find the .NET Framework C# compiler (csc.exe).' }

$numeric = ($version -replace '[-+].*$', '') + '.0'
$versionFile = Join-Path $work 'Version.cs'
@"
using System.Reflection;
[assembly: AssemblyTitle("DP File Share")]
[assembly: AssemblyProduct("DP File Share")]
[assembly: AssemblyDescription("Share files on this PC through private, expiring links")]
[assembly: AssemblyCompany("DP File Share contributors")]
[assembly: AssemblyCopyright("MIT License")]
[assembly: AssemblyVersion("$numeric")]
[assembly: AssemblyFileVersion("$numeric")]
[assembly: AssemblyInformationalVersion("$version")]
"@ | Set-Content $versionFile -Encoding UTF8

$exe = Join-Path $dist 'DP File Share.exe'
Invoke-Checked 'Compiling the tray program' {
  & $csc /nologo /target:winexe /optimize+ /platform:anycpu /codepage:65001 "/out:$exe" `
    "/win32icon:$root\tray\app.ico" "/resource:$idFile,engine.id" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll "$root\tray\Tray.cs" $versionFile
}

# The compressed engine goes after the end of the program, followed by its length and a marker
# (see UnpackEngine in Tray.cs). Kept out of the program's own resources so that Windows doesn't
# load all of it into memory just to show the tray icon.
$append = [System.IO.File]::Open($exe, 'Append')
$source = [System.IO.File]::OpenRead($packed)
$source.CopyTo($append)
$tail = [BitConverter]::GetBytes([int64]$source.Length) + [System.Text.Encoding]::ASCII.GetBytes('DPFSENG1')
$append.Write($tail, 0, $tail.Length)
$source.Dispose(); $append.Dispose()

$size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "Built $exe ($size MB)"
