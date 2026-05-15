param(
  [ValidateSet('stop', 'status')]
  [string]$Mode = 'status'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = if ($env:RUNTIME_ROOT -and $env:RUNTIME_ROOT.Trim()) {
  $env:RUNTIME_ROOT.Trim()
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA 'FeishuCodexBot'
} else {
  Join-Path $projectRoot '.runtime\FeishuCodexBot'
}
$runDir = Join-Path $runtimeRoot 'run'
$targets = @(
  @{
    Name = 'gateway'
    LockFile = Join-Path $runDir 'gateway.lock'
    HealthFile = Join-Path $runDir 'gateway.health.json'
    Entry = 'dist\apps\bot-gateway\main.js'
  },
  @{
    Name = 'worker'
    LockFile = Join-Path $runDir 'worker.lock'
    HealthFile = Join-Path $runDir 'worker.health.json'
    Entry = 'dist\apps\assistant-worker\main.js'
  }
)

function Read-JsonPid([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) {
    return $null
  }

  try {
    $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    if (-not $raw.Trim()) {
      return $null
    }
    $parsed = $raw | ConvertFrom-Json
    if ($parsed.pid -is [int] -or $parsed.pid -is [long]) {
      return [int]$parsed.pid
    }
    return $null
  } catch {
    return $null
  }
}

function Test-PidAlive([int]$targetProcId) {
  try {
    Get-Process -Id $targetProcId -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Get-FallbackNodeProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and (
      $_.CommandLine -like '*dist\apps\assistant-worker\main.js*' -or
      $_.CommandLine -like '*dist/apps/assistant-worker/main.js*' -or
      $_.CommandLine -like '*dist\apps\bot-gateway\main.js*' -or
      $_.CommandLine -like '*dist/apps/bot-gateway/main.js*'
    )
  }
}

function Get-ManagedProcesses {
  $results = @()

  foreach ($target in $targets) {
    $targetPid = Read-JsonPid $target.LockFile
    if (-not $targetPid) {
      $targetPid = Read-JsonPid $target.HealthFile
    }

    if ($targetPid -and (Test-PidAlive $targetPid)) {
      $results += [PSCustomObject]@{
        Name = $target.Name
        ProcessId = $targetPid
        Source = 'pid-file'
        CommandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid").CommandLine
      }
    }
  }

  if ($results.Count -gt 0) {
    return $results | Sort-Object ProcessId -Unique
  }

  $fallback = foreach ($process in Get-FallbackNodeProcesses) {
    $name = if (
      $process.CommandLine -like '*dist\apps\assistant-worker\main.js*' -or
      $process.CommandLine -like '*dist/apps/assistant-worker/main.js*'
    ) {
      'worker'
    } else {
      'gateway'
    }

    [PSCustomObject]@{
      Name = $name
      ProcessId = $process.ProcessId
      Source = 'command-line'
      CommandLine = $process.CommandLine
    }
  }

  return $fallback | Sort-Object ProcessId -Unique
}

$processes = @(Get-ManagedProcesses)

if ($Mode -eq 'status') {
  if ($processes.Count -eq 0) {
    Write-Output '[INFO] No managed Feishu server processes are running.'
    exit 0
  }

  $processes |
    Sort-Object Name, ProcessId |
    Format-Table Name, ProcessId, Source, CommandLine -AutoSize
  exit 0
}

if ($processes.Count -eq 0) {
  Write-Output '[INFO] No managed Feishu server processes to stop.'
  exit 0
}

foreach ($process in $processes) {
  try {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    Write-Output ("[INFO] Stopped {0} pid={1} via {2}" -f $process.Name, $process.ProcessId, $process.Source)
  } catch {
    Write-Output ("[WARN] Failed to stop {0} pid={1}: {2}" -f $process.Name, $process.ProcessId, $_.Exception.Message)
  }
}
