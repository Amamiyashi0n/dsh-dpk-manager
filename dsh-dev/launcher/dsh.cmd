@echo off
rem ============================================================================
rem  DeepSeek Harness (DSH) launcher
rem
rem  Double-click, or:  dsh.cmd                 -> stop the previous instance,
rem                                                then serve the Web UI on 51080
rem                     dsh.cmd stop            -> stop the previous instance only
rem                     dsh.cmd headless "task" -> run one task headless
rem                     dsh.cmd web --port 8080 -> serve on another port
rem                     dsh.cmd --help          -> CLI help
rem
rem  Paths are derived from this script's location (dsh-dev\launcher\), so the
rem  folders can be moved as long as deepseek-harness stays a sibling directory
rem  and this script keeps its depth relative to the workspace root.
rem ============================================================================

setlocal EnableExtensions
title DeepSeek Harness

set "HERE=%~dp0"
rem REPO = workspace root (zcode-dev): two levels above dsh-dev\launcher\.
for %%I in ("%HERE%..\..") do set "REPO=%%~fI"
for %%I in ("%HERE%..\deepseek-harness") do set "DSH_ROOT=%%~fI"
set "CLI_ENTRY=%DSH_ROOT%\apps\cli\src\bin.ts"
set "NODE_TRADITIONAL=C:\Program Files\nodejs\node.exe"
set "PATH=C:\Program Files\nodejs;%PATH%"
set "DSH_ZCODE_REPO=%REPO%"
set "TSX_IMPORT=%DSH_ROOT:\=/%/node_modules/tsx/dist/esm/index.mjs"
set "TSX_TSCONFIG_PATH=%DSH_ROOT%\tsconfig.json"
set "KEYFILE=%REPO%\.debug\dsh-api-key.txt"

rem --- always run DSH elevated -----------------------------------------------
powershell -NoProfile -Command ^
  "$identity = [Security.Principal.WindowsIdentity]::GetCurrent();" ^
  "$principal = New-Object Security.Principal.WindowsPrincipal($identity);" ^
  "$high = & (Join-Path $env:SystemRoot 'System32\whoami.exe') /groups | Select-String 'S-1-16-12288';" ^
  "if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and $high) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  set "DSH_ELEVATE_TARGET=%~f0"
  set "DSH_ELEVATE_ARGS=%*"
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "try { $options = @{ FilePath = $env:DSH_ELEVATE_TARGET; WorkingDirectory = $env:DSH_ROOT; Verb = 'RunAs' }; if (-not [string]::IsNullOrWhiteSpace($env:DSH_ELEVATE_ARGS)) { $options.ArgumentList = $env:DSH_ELEVATE_ARGS }; Start-Process @options; exit 0 } catch { Write-Host ('[dsh] ERROR: administrator launch failed: ' + $_.Exception.Message); exit 1 }"
  if errorlevel 1 pause
  exit /b
)

powershell -NoProfile -Command ^
  "$identity = [Security.Principal.WindowsIdentity]::GetCurrent();" ^
  "$principal = New-Object Security.Principal.WindowsPrincipal($identity);" ^
  "$high = & (Join-Path $env:SystemRoot 'System32\whoami.exe') /groups | Select-String 'S-1-16-12288';" ^
  "if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and $high) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo [dsh] ERROR: elevated administrator token was not acquired.
  pause
  exit /b 1
)
echo [dsh] administrator token: enabled (High integrity)

rem --- ports ----------------------------------------------------------------
rem  WEB_PORT is where the Web UI is served.  OLD_PORT is the historical default
rem  that earlier sessions used; both are checked when stopping the previous
rem  instance so switching ports does not leave the old server behind.
set "WEB_PORT=51080"
set "OLD_PORT=3080"

rem --- preflight: fail loudly with a readable message ------------------------
if not exist "%CLI_ENTRY%" (
  echo [dsh] ERROR: cannot find the harness checkout.
  echo [dsh]   looked for: "%CLI_ENTRY%"
  echo [dsh]   this launcher expects to sit at dsh-dev\launcher\, next to the
  echo [dsh]   deepseek-harness checkout, two levels under the workspace root.
  echo.
  pause
  exit /b 1
)
if not exist "%NODE_TRADITIONAL%" (
  echo [dsh] ERROR: traditional Node.js not found.
  echo [dsh]   looked for: "%NODE_TRADITIONAL%"
  echo [dsh]   install Node.js for Windows, then start this launcher again.
  echo.
  pause
  exit /b 1
)
echo [dsh] runtime Node: %NODE_TRADITIONAL%

rem --- one canonical data root; child processes inherit the administrator token
set "DSH_HOME=%USERPROFILE%\.dsh"
echo [dsh] home: %DSH_HOME%
echo [dsh] temp: %TEMP%

rem --- DeepSeek API key: use the environment if set, else the local key file --
if not defined DEEPSEEK_API_KEY (
  if exist "%KEYFILE%" (
    set /p DEEPSEEK_API_KEY=<"%KEYFILE%"
  ) else (
    echo [dsh] WARNING: DEEPSEEK_API_KEY is not set and no key file was found.
    echo [dsh]   looked for: "%KEYFILE%"
    echo [dsh]   DeepSeek models will be unavailable until you set it.
    echo.
  )
)

rem Keep DSH's process cwd at the checkout root. Session persistence groups
rem history by the workspace cwd, so this must match the workspace used by
rem earlier zcode-dev sessions rather than the nested harness source folder.
cd /d "%REPO%"

rem --- no arguments: switch ports. stop the old server, serve on WEB_PORT ----
if "%~1"=="" (
  echo [dsh] stopping any DeepSeek Harness instance on port %OLD_PORT% or %WEB_PORT% ...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%stop-dsh.ps1" -PortList %OLD_PORT%,%WEB_PORT% -Marker "%CLI_ENTRY%" -NodePath "%NODE_TRADITIONAL%"
  echo.
  echo [dsh] starting Web UI on http://127.0.0.1:%WEB_PORT% - close this window or press Ctrl+C to stop
  echo.
  "%NODE_TRADITIONAL%" --expose-internals --import "file:///%TSX_IMPORT%" "%CLI_ENTRY%" web --port %WEB_PORT%
) else if /i "%~1"=="stop" (
  echo [dsh] stopping any DeepSeek Harness instance on port %OLD_PORT% or %WEB_PORT% ...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%stop-dsh.ps1" -PortList %OLD_PORT%,%WEB_PORT% -Marker "%CLI_ENTRY%" -NodePath "%NODE_TRADITIONAL%"
  echo.
  pause
) else (
  "%NODE_TRADITIONAL%" --expose-internals --import "file:///%TSX_IMPORT%" "%CLI_ENTRY%" %*
)

set "EC=%ERRORLEVEL%"

rem --- keep the window open on failure so the error stays readable -----------
if not "%EC%"=="0" (
  echo.
  echo [dsh] exited with code %EC%
  pause
)

exit /b %EC%
