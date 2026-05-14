# Operations

## 运行目录

默认运行目录：

- `%LOCALAPPDATA%\\FeishuCodexBot\\`

包含：

- `config/`
- `data/`
- `backups/`
- `logs/`
- `run/`

## 健康文件

- `run/gateway.health.json`
- `run/worker.health.json`

重点字段：

- `status`
- `lastHeartbeatAt`
- `jobs`
- `workerId`（worker）

## 配置优先级

优先级从高到低：

1. 环境变量
2. `run/config/local.json`
3. `config/default.json`

敏感项仍推荐仅放环境变量。

## 常见故障

### 1. 重复启动

- 现象：启动时报已有实例运行。
- 原因：`run/*.lock` 锁文件对应的进程仍存在。
- 处理：
  - 检查对应进程是否仍在运行。
  - 若进程已退出，重启服务时会自动回收陈旧锁文件。

### 2. 迁移失败

- 现象：启动阶段报 migration 错误并退出。
- 处理：
  - 查看 `logs/*.log` 中的 migration 记录。
  - 先备份当前 `data/`。
  - 修正 SQL 或恢复备份后再重试。

### 3. websocket 连接异常

- 现象：日志出现 `system busy`、`connect failed`。
- 处理：
  - 检查飞书后台长连接状态。
  - 必要时切换到 webhook 模式。

### 4. delivery 积压

- 现象：worker health 中 `jobs.retry_wait` 增加。
- 处理：
  - 检查飞书发送接口和 OpenAI 接口状态。
  - 查看 `job_attempts`、`deliveries`、`jobs` 表中的错误信息。

