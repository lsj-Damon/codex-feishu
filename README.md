# Feishu Local Coding Assistant

本仓库当前实现到 `M1` 的最小主链路：

- 飞书长连接接收 `im.message.receive_v1`
- 单聊文本消息过滤和规范化
- SQLite 落库 `raw_events`、`conversations`、`messages`、`jobs`
- worker 轮询任务，调用 OpenAI Responses API 生成回复
- 通过飞书消息接口回写文本回复

## 环境要求

- Node.js 24+
- Bun 1.3+
- 可用的飞书企业自建应用凭据
- 可用的 OpenAI API Key

## 配置

1. 参考 `.env.example` 配置环境变量。
2. 默认运行目录为 `%LOCALAPPDATA%\\FeishuCodexBot\\`。
3. 若需要自定义运行目录，可设置 `RUNTIME_ROOT`。
4. 飞书接入支持两种模式：
   - `FEISHU_CONNECTION_MODE=websocket`
   - `FEISHU_CONNECTION_MODE=webhook`
5. 本地推荐先试 `websocket`。如果长连接持续异常，可切到 `webhook` 并补齐：
   - `FEISHU_VERIFICATION_TOKEN`
   - `FEISHU_ENCRYPT_KEY`
   - `FEISHU_BIND_HOST`
   - `FEISHU_BIND_PORT`
   - `FEISHU_CALLBACK_PATH`
   - `FEISHU_PUBLIC_BASE_URL`
6. 运行配置支持文件覆盖：
   - `config/default.json`
   - `<runtimeRoot>\\config\\local.json`
   - 环境变量优先级最高

## 安装依赖

```powershell
npm.cmd install --cache .npm-cache
```

## 初始化数据库

```powershell
npm.cmd run migrate
```

## 本地开发

分别启动两个进程：

```powershell
npm.cmd run dev:gateway
```

```powershell
npm.cmd run dev:worker
```

当前仓库的开发脚本采用“先编译再运行 `dist/`”的方式，避免不同 TypeScript 运行器在本机环境中的差异。

## 构建

```powershell
npm.cmd run typecheck
npm.cmd run build
```

## 当前范围

当前仓库已完成 `M1` 到 `M4` 的主要本地实现：

- 默认单聊可直接处理，群聊仅在开启 `ALLOW_GROUPS=true` 且命中 `@机器人` 条件后处理
- 已实现 `deliveries` / `job_attempts`
- 已实现 worker 租约续租、过期恢复、delivery-only retry 和 health 文件
- 已实现 M3 的本地摘要、追问、上下文窗口和 `previous_response_id` 回退
- 已实现 Feishu `websocket` / `webhook` 双接入模式
- 已实现 M4 的配置文件覆盖、单实例保护、备份/清理脚本和运维文档
- 已实现单图图片消息 MVP：图片事件可入队、附件元数据可落库、worker 会下载第一张图并尝试把它送进模型

需要注意：

- 真实飞书 websocket 入站链路仍在单独排查
- 计划任务脚本已提供，但尚未在当前会话里实际安装到系统

## M2 本地验证

```powershell
npm.cmd run smoke:m2
```

## 单图图片 MVP 本地验证

```powershell
npm.cmd run smoke:image-mvp
```

## M3 本地验证

```powershell
npm.cmd run smoke:m3
```

## M4 本地验证

```powershell
npm.cmd run smoke:m4
```

## M4 运维脚本

数据库备份：

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/backup-db.ps1
```

数据库与日志清理：

```powershell
node --experimental-strip-types scripts/cleanup-db.ts
```

计划任务安装：

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/install-scheduled-tasks.ps1 -Mode install
```
