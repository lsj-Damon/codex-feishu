# Runbook

## 启动

1. 确认 `.env` 或 `config/default.json` / `run/config/local.json` 配置完整。
2. 运行数据库迁移：

```powershell
npm.cmd run migrate
```

3. 分别启动两个进程：

```powershell
npm.cmd run start:gateway
```

```powershell
npm.cmd run start:worker
```

## 停止

- 在前台运行时使用 `Ctrl+C` 停止。
- 如使用计划任务运行，先停止计划任务，再确认 `run/` 下的锁文件消失。

## 备份

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/backup-db.ps1
```

## 清理

```powershell
node --experimental-strip-types scripts/cleanup-db.ts
```

## 恢复

1. 停止 gateway 和 worker。
2. 从 `backups/<timestamp>/` 选定备份目录。
3. 将 `app.db`、`app.db-wal`、`app.db-shm` 覆盖回运行目录的 `data/`。
4. 重新执行 `npm.cmd run migrate`。
5. 启动 gateway 和 worker，并检查 `run/*.health.json` 与日志。

## 计划任务

安装：

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/install-scheduled-tasks.ps1 -Mode install
```

重装：

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/install-scheduled-tasks.ps1 -Mode reinstall
```

卸载：

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/install-scheduled-tasks.ps1 -Mode uninstall
```

