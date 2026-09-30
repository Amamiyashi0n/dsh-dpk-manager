<#
.SYNOPSIS
  Stop DeepSeek Harness Web instances listening on the given ports.

.DESCRIPTION
  Finds whoever LISTENs on each port and stops it only when it is provably a DSH
  instance: its command line must contain this checkout's absolute apps/cli entry.
  Anything else on that port is reported and left alone.

  Run by dsh.cmd before starting, and directly as `dsh.cmd stop`.

  Ports arrive as a comma- or space-separated string because `powershell -File`
  does not build arrays from arguments; a literal `-Ports 3080,51080` bound to an
  [int[]] parameter silently collapses into the single number 308051080.

.PARAMETER PortList
  Comma- or space-separated ports to clear, e.g. "3080,51080".

.PARAMETER Marker
  Absolute command-line substring identifying this checkout's entry point.

.PARAMETER DryRun
  Report what would be stopped without stopping anything.

.EXAMPLE
  .\stop-dsh.ps1 -PortList '3080,51080' -Marker 'C:\checkout\apps\cli\src\bin.ts'
  .\stop-dsh.ps1 -PortList '51080' -Marker 'C:\checkout\apps\cli\src\bin.ts' -DryRun
#>
param(
  [string] $PortList = '3080,51080',
  [Parameter(Mandatory = $true)] [string] $Marker,
  [string] $NodePath = '',
  [switch] $DryRun
)

$ErrorActionPreference = 'Continue'

# Compare paths with one separator and one case: the command line keeps whatever
# the launcher typed (`apps/cli/src/bin.ts`, forward slashes) while Win32 paths
# use backslashes, and %REPO% may still carry a literal `\..` segment.
function ConvertTo-ComparablePath {
  param([string] $Value)
  if (-not $Value) { return '' }
  return ($Value -replace '/', '\').ToLowerInvariant()
}

$markerCmp = ConvertTo-ComparablePath ([System.IO.Path]::GetFullPath($Marker))
$nodeCmp = if ($NodePath) { ConvertTo-ComparablePath ([System.IO.Path]::GetFullPath($NodePath)) } else { '' }
# Location-independent DSH entry form: matches `apps\cli\src\bin.ts` (historical
# cwd-relative start) and any `...\deepseek-harness\apps\cli\src\bin.ts` — checkouts
# relocated after an instance was already started (e.g. the 2026-09 dsh-dev
# reorganization) keep the old absolute path in their command line, which the
# marker above can no longer match.
$relativeEntryPattern = '(^|[\\/\s"])(deepseek-harness[\\/])?apps[\\/]cli[\\/]src[\\/]bin\.ts'

$ports = @(
  $PortList -split '[,;\s]+' |
    Where-Object { $_ -ne '' } |
    ForEach-Object { [int] $_ }
)
if ($ports.Count -eq 0) {
  Write-Host 'stop-dsh: no ports given'
  exit 0
}

function Get-ListenerPid {
  param([int] $Port)
  try {
    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    # Get-NetTCPConnection needs the NetTCPIP module; fall back to netstat.
    $rows = netstat -ano | Select-String ":$Port\s+.*LISTENING\s+(\d+)\s*$"
    return @($rows | ForEach-Object { [int] $_.Matches[0].Groups[1].Value } | Select-Object -Unique)
  }
}

$stopped = 0
$skipped = 0

foreach ($port in $ports) {
  $pids = Get-ListenerPid -Port $port
  if ($pids.Count -eq 0) {
    Write-Host "  port ${port}: free"
    continue
  }

  foreach ($procId in $pids) {
    if ($procId -eq 0) { continue }

    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.Name } else { '(unreadable)' }
    $cmdLine = if ($proc) { [string] $proc.CommandLine } else { '' }
    $cmdCmp = ConvertTo-ComparablePath $cmdLine
    $exeCmp = if ($proc) { ConvertTo-ComparablePath ([string] $proc.ExecutablePath) } else { '' }
    $absoluteEntry = $cmdCmp -and $cmdCmp.Contains($markerCmp)
    # Historical starts used a cwd-relative CLI entry. Accept that exact form
    # only when the listener is running under this launcher's pinned Node.
    $relativeEntry = $cmdLine -match $relativeEntryPattern -and $nodeCmp -and $exeCmp -eq $nodeCmp
    $isOurs = $absoluteEntry -or $relativeEntry
    $why = if ($absoluteEntry) { 'command line references this checkout entry' } else { 'pinned Node runs the exact DSH relative entry' }

    if (-not $isOurs) {
      Write-Host "  port ${port}: PID $procId ($name) is NOT a DSH instance - left running"
      if (-not $cmdLine) {
        Write-Host '           (its command line is unreadable from this process view)'
      }
      $skipped++
      continue
    }

    if ($DryRun) {
      Write-Host "  port ${port}: would stop PID $procId ($name; $why)"
      $stopped++
      continue
    }

    try {
      Stop-Process -Id $procId -Force -ErrorAction Stop
      Write-Host "  port ${port}: stopped PID $procId ($name; $why)"
      $stopped++
    } catch {
      Write-Host "  port ${port}: FAILED to stop PID $procId - $($_.Exception.Message)"
      $skipped++
    }
  }
}

$verb = if ($DryRun) { 'would stop' } else { 'stopped' }
Write-Host "stop-dsh: $verb $stopped, skipped $skipped"
exit 0
