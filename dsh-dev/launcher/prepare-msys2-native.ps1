<#
.SYNOPSIS
  Ensure native addons used by the DSH profile are built for the pinned MSYS2 Node.

.DESCRIPTION
  The published koffi Windows binary is built for the MSVC Node runtime.  It can
  terminate a MSYS2 Node process during dlopen instead of returning a load error,
  so a normal JavaScript try/catch cannot protect the launcher.  Probe it in a
  child process and rebuild from the bundled source when the probe fails.

.LEGACY (2026-09-29)
  DSH and the zcode-provider appServer now pin the traditional Node
  (C:\Program Files\nodejs) and nothing invokes this script anymore.  Keep it
  only for reviving the MSYS2 clang64 Node experiment; do not point node back
  at clang64 in the shell or PATH.
#>
param(
  [Parameter(Mandatory = $true)] [string] $Repo,
  [Parameter(Mandatory = $true)] [string] $NodePath,
  [Parameter(Mandatory = $true)] [string] $Msys2Root
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$highIntegrity = & (Join-Path $env:SystemRoot 'System32\whoami.exe') /groups | Select-String 'S-1-16-12288'
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or -not $highIntegrity) {
  throw 'prepare-msys2-native: an elevated administrator token is required'
}

$expectedNodePath = [System.IO.Path]::GetFullPath((Join-Path $Msys2Root 'clang64\bin\node.exe'))
$actualNodePath = [System.IO.Path]::GetFullPath($NodePath)
if (-not [string]::Equals($actualNodePath, $expectedNodePath, [StringComparison]::OrdinalIgnoreCase)) {
  throw "prepare-msys2-native: Node must be the CLANG64 runtime at $expectedNodePath"
}

function ConvertTo-MsysPath {
  param([Parameter(Mandatory = $true)] [string] $Path)
  $full = [System.IO.Path]::GetFullPath($Path) -replace '\\', '/'
  if ($full -match '^([A-Za-z]):/(.*)$') {
    return "/$($matches[1].ToLowerInvariant())/$($matches[2])"
  }
  throw "prepare-msys2-native: path is not a Windows drive path: $Path"
}

function Test-KoffiBinary {
  param([Parameter(Mandatory = $true)] [string] $Path)
  $probe = 'require(process.argv[1])'
  & $NodePath -e $probe $Path 2>$null
  return $LASTEXITCODE -eq 0
}

$bunDir = Join-Path $Repo 'deepseek-harness\node_modules\.bun'
$koffiDir = Get-ChildItem -Path $bunDir -Directory -Filter 'koffi@*' |
  ForEach-Object {
    $candidate = Join-Path $_.FullName 'node_modules\koffi'
    if (Test-Path (Join-Path $candidate 'cnoke.cjs')) { Get-Item $candidate }
  } |
  Sort-Object FullName -Descending |
  Select-Object -First 1
$target = Get-ChildItem -Path $bunDir -Directory -Filter '@koromix+koffi-win32-x64@*' |
  ForEach-Object {
    $candidate = Join-Path $_.FullName 'node_modules\@koromix\koffi-win32-x64\win32_x64\koffi.node'
    if (Test-Path $candidate) { Get-Item $candidate }
  } |
  Sort-Object FullName -Descending |
  Select-Object -First 1

if ($null -eq $koffiDir -or $null -eq $target) {
  Write-Host '[dsh] native: koffi package is not installed; skipping native preparation.'
  exit 0
}

if (Test-KoffiBinary -Path $target.FullName) {
  Write-Host '[dsh] native: koffi is compatible with the pinned MSYS2 Node.'
  exit 0
}

Write-Host '[dsh] native: rebuilding koffi for MSYS2 Node 24 (the prebuilt MSVC binary is incompatible).'
$bash = Join-Path $Msys2Root 'usr\bin\bash.exe'
if (-not (Test-Path $bash)) { throw "prepare-msys2-native: MSYS2 bash not found: $bash" }

$koffiMsys = ConvertTo-MsysPath $koffiDir.FullName
$buildCommand = @"
export MSYSTEM=CLANG64
export MSYS2_ROOT='$Msys2Root'
export MSYS2_HOME="`$MSYS2_ROOT"
export MSYS2_PATH_TYPE=inherit
export CHERE_INVOKING=1
export MINGW_PREFIX=/clang64
export MSYSTEM_PREFIX=/clang64
export PATH=/clang64/bin:/mingw64/bin:/usr/bin:`$PATH
cd '$koffiMsys'
/clang64/bin/node.exe ./cnoke.cjs -P . -D src/koffi --prebuild --release
"@
& $bash --login -lc $buildCommand
if ($LASTEXITCODE -ne 0) { throw "prepare-msys2-native: koffi build failed with exit code $LASTEXITCODE" }

$built = Get-ChildItem -Path (Join-Path $koffiDir.FullName 'build\koffi\win32_x64') -Recurse -File -Filter 'koffi.node' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if ($null -eq $built) { throw 'prepare-msys2-native: build completed without producing koffi.node' }

Copy-Item -LiteralPath $built.FullName -Destination $target.FullName -Force
if (-not (Test-KoffiBinary -Path $target.FullName)) {
  throw 'prepare-msys2-native: rebuilt koffi failed the MSYS2 Node probe'
}
Write-Host '[dsh] native: koffi rebuilt and verified.'
