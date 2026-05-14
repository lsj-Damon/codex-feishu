# Runbook

## Scope

This runbook covers the current `feishu-server` runtime after the Codex-backed worker integration:

- Feishu ingress is handled by `bot-gateway`
- project control commands and ordinary analysis messages are handled by `assistant-worker`
- ordinary worker execution now goes through Codex CLI sessions under `D:\Develop\workspace`

## Runtime Layout

Default runtime root:

- `%LOCALAPPDATA%\FeishuCodexBot\`

Override:

- set `RUNTIME_ROOT=<custom path>`

Important subdirectories:

- `config/`
- `data/`
- `logs/`
- `run/`
- `runs/codex/`
- `backups/`

## Prerequisites

- Node.js 24+
- `npm.cmd`
- valid Feishu app credentials in `.env`
- Codex CLI installed locally
- on this machine, the known-good explicit path is:
  - `E:\AppInstall\nodejs\node_global\codex.cmd`

Recommended `.env` Codex settings:

```powershell
CODEX_WORKSPACE_ROOT=D:\Develop\workspace
CODEX_CLI_PATH=E:\AppInstall\nodejs\node_global\codex.cmd
CODEX_EXEC_TIMEOUT_MS=600000
CODEX_MAX_PROGRESS_MESSAGE_INTERVAL_MS=3000
CODEX_MAX_OUTPUT_CHARS=4000
```

## Start

1. Build:

```powershell
npm.cmd run build
```

2. Run migrations:

```powershell
npm.cmd run migrate
```

3. Start gateway:

```powershell
npm.cmd run start:gateway
```

4. Start worker:

```powershell
npm.cmd run start:worker
```

For local debugging with explicit runtime root:

```powershell
$env:RUNTIME_ROOT='D:\Develop\workspace\feishu-server\.runtime\live-codex-feishu'
npm.cmd run start:gateway
```

```powershell
$env:RUNTIME_ROOT='D:\Develop\workspace\feishu-server\.runtime\live-codex-feishu'
npm.cmd run start:worker
```

## Health and Logs

Health files:

- `run/gateway.health.json`
- `run/worker.health.json`

Important fields:

- `status`
- `lastHeartbeatAt`
- `processedJobs`
- `jobs`
- `workerId`

Primary logs:

- `logs/gateway.log`
- `logs/worker.log`

Codex run artifacts:

- `runs/codex/run-<id>/prompt.txt`
- `runs/codex/run-<id>/codex-run.jsonl`
- `runs/codex/run-<id>/codex-run.stderr.log`

## Message Types

### Control commands

These are handled locally by the worker and do not require Codex execution:

- `项目列表`
- `当前项目`
- `切换项目 <name>`
- `新建项目 <name>`

### Ordinary messages

Ordinary Feishu messages:

- bind to the current project
- use or resume the current Codex session
- stream progress back to Feishu
- send a final summary message when complete

## Verified Real Flow

The following path has already been validated against a real Feishu p2p chat:

1. `切换项目 feishu-server`
2. `请分析当前项目的核心执行流，并给出最关键的三个模块`

Observed successful outcomes:

- project switch job succeeded
- Codex session was created and persisted
- ordinary analysis job succeeded
- final Feishu delivery succeeded

Live database evidence from the validated run:

- `job_id=9` control command succeeded
- `job_id=10` analysis job succeeded
- successful Codex session id:
  - `019e25c3-6480-7a92-82be-c868b9d5f0d0`
- successful analysis run:
  - `run_id=12`

## Windows-Specific Notes

### 1. Do not rely on bare `codex`

Background worker runs may not inherit a PATH that resolves `codex`.

Use explicit:

- `CODEX_CLI_PATH=E:\AppInstall\nodejs\node_global\codex.cmd`

### 2. Codex launcher is required

The worker does not directly spawn `codex.cmd`.

Instead it launches:

- `node dist/scripts/codex-launcher.js`

The launcher:

- reads prompt text from a file
- feeds it through stdin
- normalizes Windows `.cmd/.ps1` startup
- forwards stdout/stderr safely

### 3. Expect noisy output

This environment emits extra non-JSON lines such as:

- `[ANOMALY: use of REX.w is meaningless ...]`

Codex parsing only trusts valid JSON lines from stdout.

## Common Failure Modes

### `spawn codex ENOENT`

Cause:

- worker cannot resolve Codex CLI from PATH

Fix:

- set `CODEX_CLI_PATH` to the absolute `.cmd` path
- rebuild and restart worker

### `spawn EINVAL`

Cause:

- Windows command-line spawning edge cases

Fix:

- ensure the Node launcher path is being used
- rebuild after launcher changes
- restart worker

### `EPIPE: broken pipe, write`

Cause:

- background Windows stdio/pipe instability during long Codex runs

Current mitigation:

- logger console writes are guarded
- launcher stdout/stderr writes are guarded
- progress stream delivery failures are downgraded to warnings

If it reappears:

1. inspect `logs/worker.log`
2. inspect `runs/codex/run-<id>/codex-run.jsonl`
3. inspect `runs/codex/run-<id>/codex-run.stderr.log`
4. check whether `jobs`, `codex_runs`, and `codex_sessions` need manual recovery

### Worker stuck in `busy` / job stuck in `running`

Use a manual recovery pass only when necessary:

1. stop worker
2. inspect the latest `codex_runs`
3. reset stuck rows:
   - `jobs.status -> queued or failed`
   - `codex_sessions.status -> active or idle`
   - `codex_runs.status -> failed`
4. restart worker

## Backup

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/backup-db.ps1
```

## Cleanup

```powershell
node --experimental-strip-types scripts/cleanup-db.ts
```

## Restore

1. Stop gateway and worker.
2. Choose a backup under `backups/<timestamp>/`.
3. Restore `app.db`, `app.db-wal`, and `app.db-shm` into `data/`.
4. Re-run:

```powershell
npm.cmd run migrate
```

5. Start gateway and worker again.
6. Check:
   - `run/*.health.json`
   - `logs/*.log`

## Scheduled Tasks

Install:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/install-scheduled-tasks.ps1 -Mode install
```

Reinstall:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/install-scheduled-tasks.ps1 -Mode reinstall
```

Uninstall:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/install-scheduled-tasks.ps1 -Mode uninstall
```
