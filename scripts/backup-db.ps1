param(
  [string]$RuntimeRoot = $env:RUNTIME_ROOT,
  [int]$KeepCount = 5
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

$dataDir = Join-Path $RuntimeRoot 'data'
$dbFile = Join-Path $dataDir 'app.db'
$backupsDir = Join-Path $RuntimeRoot 'backups'
New-Item -ItemType Directory -Force $backupsDir | Out-Null

if (-not (Test-Path $dbFile)) {
  throw "Database file not found: $dbFile"
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$targetDir = Join-Path $backupsDir $timestamp
New-Item -ItemType Directory -Force $targetDir | Out-Null

$copied = @()
foreach ($suffix in @('', '-wal', '-shm')) {
  $source = "$dbFile$suffix"
  if (Test-Path $source) {
    Copy-Item -LiteralPath $source -Destination $targetDir -Force
    $copied += [System.IO.Path]::GetFileName($source)
  }
}

$manifest = [PSCustomObject]@{
  createdAt = (Get-Date).ToString('o')
  runtimeRoot = $RuntimeRoot
  files = $copied
}
$manifest | ConvertTo-Json | Set-Content -Path (Join-Path $targetDir 'backup.json')

$backupDirs = @(Get-ChildItem -Path $backupsDir -Directory | Sort-Object Name -Descending)
if ($backupDirs.Count -gt $KeepCount) {
  $backupDirs | Select-Object -Skip $KeepCount | Remove-Item -Recurse -Force
}

Write-Host "Backup created at $targetDir"
