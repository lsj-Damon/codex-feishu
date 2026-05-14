param(
  [ValidateSet('install', 'uninstall', 'reinstall')]
  [string]$Mode = 'install',
  [string]$Workdir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$RuntimeRoot = $env:RUNTIME_ROOT,
  [string]$TaskPrefix = 'FeishuCodexBot',
  [string]$NodeExe = 'node'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  if ($env:LOCALAPPDATA) {
    $RuntimeRoot = Join-Path $env:LOCALAPPDATA 'FeishuCodexBot'
  } else {
    throw 'RuntimeRoot is required when LOCALAPPDATA is unavailable.'
  }
}

$gatewayTask = "$TaskPrefix-Gateway"
$workerTask = "$TaskPrefix-Worker"

function New-CodexTaskAction([string]$entrypoint) {
  $command = "set RUNTIME_ROOT=$RuntimeRoot&& cd /d `"$Workdir`"&& `"$NodeExe`" `"$entrypoint`""
  return New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $command"
}

function Register-CodexTask([string]$taskName, [string]$entrypoint) {
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege
  Register-ScheduledTask `
    -TaskName $taskName `
    -Action (New-CodexTaskAction $entrypoint) `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Starts $taskName for Feishu local coding assistant." `
    -Force | Out-Null
}

function Remove-CodexTask([string]$taskName) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
}

switch ($Mode) {
  'uninstall' {
    Remove-CodexTask $gatewayTask
    Remove-CodexTask $workerTask
    Write-Host "Removed scheduled tasks: $gatewayTask, $workerTask"
  }
  'reinstall' {
    Remove-CodexTask $gatewayTask
    Remove-CodexTask $workerTask
    Register-CodexTask $gatewayTask 'dist\apps\bot-gateway\main.js'
    Register-CodexTask $workerTask 'dist\apps\assistant-worker\main.js'
    Write-Host "Reinstalled scheduled tasks: $gatewayTask, $workerTask"
  }
  default {
    Register-CodexTask $gatewayTask 'dist\apps\bot-gateway\main.js'
    Register-CodexTask $workerTask 'dist\apps\assistant-worker\main.js'
    Write-Host "Installed scheduled tasks: $gatewayTask, $workerTask"
  }
}

