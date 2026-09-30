@echo off
rem ============================================================================
rem  Create (or recreate) the elevated "dsh-webui" Desktop shortcut.
rem ============================================================================

setlocal EnableExtensions
title Install DeepSeek Harness shortcut

set "HERE=%~dp0"
set "TARGET=%HERE%dsh.cmd"
set "ICON=%HERE%deepseek-harness.ico"
set "LNK=%USERPROFILE%\Desktop\dsh-webui.lnk"

if not exist "%TARGET%" (
  echo [error] dsh.cmd is missing next to this script:
  echo         "%TARGET%"
  echo.
  pause
  exit /b 1
)

echo Creating shortcut:
echo   target: %TARGET%
echo   link:   %LNK%
echo.

rem Pass paths through the environment: quoting them on the -Command line would
rem need double-escaped quotes for every space (e.g. "DeepSeek Harness.lnk").
set "DSH_HERE=%HERE%"
set "DSH_TARGET=%TARGET%"
set "DSH_ICON=%ICON%"
set "DSH_LNK=%LNK%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "try {" ^
  "  $ws = New-Object -ComObject WScript.Shell;" ^
  "  $sc = $ws.CreateShortcut($env:DSH_LNK);" ^
  "  $sc.TargetPath = $env:DSH_TARGET;" ^
  "  $sc.WorkingDirectory = $env:DSH_HERE;" ^
  "  if (Test-Path $env:DSH_ICON) { $sc.IconLocation = $env:DSH_ICON + ',0' };" ^
  "  $sc.Description = 'DeepSeek Harness - Web UI on http://127.0.0.1:51080';" ^
  "  $sc.WindowStyle = 1;" ^
  "  $sc.Save();" ^
  "  $bytes = [IO.File]::ReadAllBytes($env:DSH_LNK);" ^
  "  if ($bytes.Length -lt 0x16) { throw 'shortcut data is truncated' };" ^
  "  $bytes[0x15] = $bytes[0x15] -bor 0x20;" ^
  "  [IO.File]::WriteAllBytes($env:DSH_LNK, $bytes);" ^
  "} catch {" ^
  "  Write-Host '';" ^
  "  Write-Host '[error] could not write the shortcut.';" ^
  "  Write-Host ('        ' + $_.Exception.Message);" ^
  "  exit 1;" ^
  "}" ^
  "$rb = $ws.CreateShortcut($env:DSH_LNK);" ^
  "Write-Host ('  target : ' + $rb.TargetPath);" ^
  "Write-Host ('           exists: ' + (Test-Path $rb.TargetPath));" ^
  "Write-Host ('  workdir: ' + $rb.WorkingDirectory);" ^
  "Write-Host ('  icon   : ' + $rb.IconLocation);" ^
  "$bytes = [IO.File]::ReadAllBytes($env:DSH_LNK);" ^
  "Write-Host ('  admin  : ' + (($bytes[0x15] -band 0x20) -ne 0));" ^
  "Write-Host '';"

if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

echo Done - look for "dsh-webui" on your Desktop.
echo Double-click it to serve the Web UI on http://127.0.0.1:51080
echo.
pause
