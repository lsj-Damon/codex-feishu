# 飞书本地聊天式代码助手详细设计

- 文档日期：2026-04-18
- 文档状态：已确认设计，待实施
- 部署形态：本地电脑常驻服务
- 目标架构：飞书企业自建应用（机器人） -> 本地服务 -> OpenAI Responses API -> 回飞书
- 目标技术栈：Node.js 24 + TypeScript + Bun + SQLite

## 1. 背景与目标

本项目的目标是在本地电脑上运行一个常驻服务，通过飞书企业自建应用的机器人能力，接收用户在飞书单聊或群聊中的代码相关问题，调用 OpenAI Responses API 生成回复，再将结果回写到飞书。

该服务的定位不是通用聊天机器人，也不是可以直接操作本地仓库的代理系统，而是一个面向开发交流场景的聊天式代码助手。它需要在本地稳定运行，支持会话上下文、自动重试、崩溃恢复、日志排障和基础安全控制。

### 1.1 目标

- 在飞书单聊中稳定回答代码问题。
- 在飞书群聊中仅在 `@机器人` 时响应。
- 支持多轮会话上下文，并避免群聊不同用户上下文串扰。
- 在 OpenAI 或飞书接口短暂失败时自动重试。
- 在进程重启后恢复未完成任务和历史会话。
- 具备本地可维护性，包括日志、健康状态、数据库备份与升级流程。

### 1.2 非目标

以下内容不属于初版范围：

- 自动读取本地代码仓库或执行代码
- 文件上传解析、图片识别、富文本卡片消息
- 多租户、多机器人实例编排
- Web 管理界面或桌面 GUI
- 向量检索、RAG、知识库增强
- Windows Service 原生服务封装

## 2. 约束与前提

### 2.1 已确认约束

- 服务部署在用户本地电脑上，而不是云服务器。
- 飞书事件接收方式采用长连接，而不是公网 HTTPS 回调。
- 对外部大模型调用采用 OpenAI Responses API。
- 技术栈采用 `Node.js + TypeScript`。
- 包管理和开发脚本采用 `Bun`，生产运行时采用 `Node.js`。
- 本地持久化采用 `SQLite`。
- 总体架构采用双进程方案：接入层进程 + 后台任务进程。

### 2.2 本机环境结论

本机环境检查结果如下：

- Windows 10.0.26200
- PowerShell 5.1.26100.8115
- Node.js v24.13.0
- Bun 1.3.11
- Python 3.13.12
- uv 0.11.4

Node.js 与 Python 均可用，但 PowerShell 执行策略会阻止 `npm.ps1` 和 `pnpm.ps1`，而 `bun` 可正常使用。因此选择 `TypeScript + Bun + Node.js` 可以保留类型安全和服务端工程化优势，同时规避本机 PowerShell 的包管理器脚本限制。

## 3. 总体架构设计

### 3.1 架构选型

本项目采用双进程本地架构：

1. `bot-gateway`
- 负责与飞书建立长连接
- 接收消息事件
- 完成轻量校验、去重、会话路由和入队
- 不直接调用 OpenAI

2. `assistant-worker`
- 从本地任务队列中领取待处理任务
- 读取上下文并调用 OpenAI Responses API
- 生成回复并调用飞书消息接口回写
- 负责重试、限流、超时与失败恢复

3. `SQLite`
- 作为本地系统状态中心
- 同时承担事件审计、会话存储、轻量任务队列和投递状态记录

4. `shared-core`
- 两个进程共享的一组 TypeScript 模块
- 包括配置、日志、数据库访问、飞书客户端、OpenAI 客户端、错误模型和策略模块

### 3.2 选型理由

相比单进程方案，双进程架构更适合本项目的消息型工作负载：

- 飞书接入是短时轻逻辑
- OpenAI 调用是潜在长时逻辑
- 任务拆分后更容易做重试、削峰、恢复和顺序控制
- 进程重启时状态恢复更清晰
- 后续如果需要增加 worker 数量，无需重写核心调度机制

### 3.3 组件边界

`bot-gateway` 只负责接入正确性，不承担 AI 推理责任。`assistant-worker` 只负责任务执行正确性，不直接处理飞书长连接生命周期。两者通过数据库中的 `jobs` 表和相关状态表解耦，不使用内存队列作为唯一调度手段。

该设计的核心收益是：

- gateway 崩溃不会丢失已入队任务
- worker 崩溃不会导致消息重复接入
- 飞书接入速度和 OpenAI 响应速度可以独立优化

## 4. 目录结构与运行时布局

### 4.1 源码目录建议

```text
src/
  apps/
    bot-gateway/
    assistant-worker/
  core/
    config/
    db/
    logger/
    types/
  domains/
    feishu/
    openai/
    conversation/
    jobs/
    messages/
  infra/
    sqlite/
  scripts/
```

### 4.2 本机运行目录建议

运行数据不应放在源码目录中。推荐在用户本地应用目录中建立运行时目录：

```text
%LOCALAPPDATA%\FeishuCodexBot\
  bin\
  config\
  data\
    app.db
  logs\
    gateway.log
    worker.log
  run\
    gateway.health.json
    worker.health.json
```

说明：

- `bin` 存放构建产物
- `config` 存放非密钥配置
- `data` 存放 SQLite 数据库
- `logs` 存放滚动日志
- `run` 存放健康状态和运行时文件

## 5. 核心数据流与时序设计

### 5.1 主链路

1. 飞书通过长连接推送消息事件给 `bot-gateway`
2. `bot-gateway` 解析消息、过滤无关事件、规范化数据
3. `bot-gateway` 在同一事务中完成原始事件落库、消息记录落库、会话更新和任务入队
4. `assistant-worker` 领取待执行任务并读取会话上下文
5. `assistant-worker` 调用 OpenAI Responses API 生成回复
6. worker 持久化模型输出和会话状态
7. worker 通过飞书消息回复接口将内容回写到原会话
8. 成功后将任务状态改为 `succeeded`

### 5.2 消息接入规则

- 单聊默认全部响应
- 群聊默认只响应 `@机器人`
- 初版只处理文本消息
- 忽略机器人自己发出的消息，防止自触发循环
- 不匹配白名单或策略规则的消息直接忽略，不入队

### 5.3 去重原则

为避免飞书事件重投或进程重启导致重复回复，需要同时基于以下主键做去重：

- `event_id`
- `message_id`

去重应在入队前完成，并由数据库唯一索引保证幂等。

### 5.4 会话键设计

会话键用于保证上下文隔离：

- 单聊：`conversation_key = chat_id`
- 群聊：`conversation_key = chat_id + ':' + sender_open_id`

这样群聊内不同用户对机器人的提问会落入不同上下文，避免串台。

## 6. 数据模型与 SQLite 设计

SQLite 不只是聊天记录存储，而是系统状态中心。数据库既承担持久化，又承担轻量任务队列功能。

### 6.1 基础原则

- 开启 `WAL` 模式，支持 gateway 和 worker 并发访问
- 开启 `foreign_keys = ON`
- 时间字段统一使用 UTC
- 平台侧主键单独建唯一索引
- 密钥不写入数据库

### 6.2 核心数据表

#### `raw_events`

用途：保存飞书原始事件，用于审计、排障和重放。

关键字段：

- `platform`
- `event_id`
- `event_type`
- `message_id`
- `chat_id`
- `sender_open_id`
- `payload_json`
- `received_at`

约束：`UNIQUE(platform, event_id)`

#### `conversations`

用途：维护机器人会话状态。

关键字段：

- `platform`
- `conversation_key`
- `chat_id`
- `chat_type`
- `user_open_id`
- `status`
- `last_user_message_id`
- `last_assistant_message_id`
- `last_response_id`
- `summary_text`
- `message_count`
- `last_activity_at`

约束：`UNIQUE(platform, conversation_key)`

#### `messages`

用途：保存规范化后的消息历史，作为本地上下文兜底。

关键字段：

- `conversation_id`
- `platform_message_id`
- `reply_to_message_id`
- `role`
- `sender_open_id`
- `content_text`
- `content_json`
- `token_input`
- `token_output`
- `model`
- `response_id`
- `status`
- `created_at`

约束：`UNIQUE(platform, platform_message_id)`

#### `jobs`

用途：本地任务队列主表。

关键字段：

- `job_type`
- `conversation_id`
- `trigger_message_id`
- `status`
- `priority`
- `attempt_count`
- `max_attempts`
- `available_at`
- `locked_by`
- `lease_expires_at`
- `last_error_code`
- `last_error_message`
- `result_message_id`

建议状态：

- `queued`
- `running`
- `retry_wait`
- `succeeded`
- `failed`
- `cancelled`

#### `job_attempts`

用途：记录每次任务执行尝试的明细。

关键字段：

- `job_id`
- `attempt_no`
- `worker_id`
- `started_at`
- `finished_at`
- `outcome`
- `error_code`
- `error_message`
- `openai_request_id`
- `feishu_send_status`

#### `deliveries`

用途：拆分“生成回答”和“发送消息”两个阶段，确保飞书回写失败时只重试投递，不重复调用 OpenAI。

关键字段：

- `job_id`
- `assistant_message_id`
- `platform`
- `delivery_type`
- `status`
- `platform_message_id`
- `attempt_count`
- `last_error_message`

#### `settings`

用途：存储非密钥运行时配置，例如：

- 默认模型
- 最大历史轮数
- 限流阈值
- 是否仅响应 `@机器人`

### 6.3 索引建议

- `raw_events(platform, event_id)` 唯一
- `messages(platform, platform_message_id)` 唯一
- `conversations(platform, conversation_key)` 唯一
- `jobs(status, available_at)`
- `jobs(conversation_id, created_at desc)`
- `job_attempts(job_id, attempt_no)`
- `deliveries(status, updated_at)`

## 7. 任务调度、重试与限流设计

### 7.1 调度策略

worker 采用数据库轮询 + 租约锁模型，而不是进程内事件总线。

推荐参数：

- `poll_interval_ms = 1000`
- `lease_duration_ms = 120000`
- `max_attempts = 4`

worker 每轮只领取满足以下条件的任务：

- `status = queued`
- `available_at <= now`

领取任务时必须在事务内完成状态更新：

- `status = running`
- `locked_by = worker_id`
- `lease_expires_at = now + lease_duration`
- `attempt_count = attempt_count + 1`

### 7.2 租约续期与崩溃恢复

OpenAI 请求可能持续较长时间，因此 worker 必须定期续租。建议每 20 秒为正在执行的任务续租一次。若进程崩溃，租约过期后其他 worker 或重启后的 worker 可重新接管任务。

### 7.3 任务拆分原则

逻辑上拆为两类任务：

1. `reply_generation`
- 组装上下文
- 调用 OpenAI
- 产出 assistant 内容

2. `message_delivery`
- 负责把已生成内容回写到飞书
- 失败时只重试投递，不重生成

初版可以通过 `jobs + deliveries` 的组合实现该边界。

### 7.4 错误分类与重试策略

可重试错误：

- OpenAI 429
- OpenAI 临时 5xx
- 网络超时
- 飞书临时发送失败
- SQLite 短暂锁冲突

不可重试错误：

- API Key 无效
- App Secret 错误
- 权限缺失
- 请求参数非法
- 白名单或策略明确拒绝

可降级错误：

- `previous_response_id` 失效
- 会话摘要缺失
- 回复消息接口失败但创建消息接口可用

指数退避建议：

`delay = min(base * 2^(attempt-1) + jitter, max_delay)`

推荐参数：

- `base = 3s`
- `max_delay = 5min`
- `jitter = 0~2s`

### 7.5 限流策略

限流分四层：

1. 同一会话同时只允许一个生成任务运行
2. 单个用户单位时间内限制请求频率
3. 全局 OpenAI 并发限制在 2 到 4 个
4. 飞书消息投递也做并发和速率限制

推荐初始值：

- `per conversation concurrency = 1`
- `per user rpm = 10`
- `global openai concurrency = 2`
- `delivery concurrency = 2`

## 8. 安全、配置与密钥管理设计

### 8.1 安全边界

可信边界：

- 本机操作系统账户
- 本地服务进程
- 本地 SQLite 数据库文件

半可信边界：

- 飞书用户输入

不可信边界：

- 所有外部输入文本
- 飞书事件中的可显示文本
- 模型输出内容

因此系统必须默认认为：

- 用户输入可能包含恶意 prompt
- 模型输出可能不准确
- 日志和数据库不能泄露敏感信息

### 8.2 密钥管理原则

以下内容绝不落库：

- `OPENAI_API_KEY`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- 后续任何本地加密主密钥

推荐密钥来源顺序：

1. Windows Credential Manager
2. 系统环境变量
3. `.env.local` 仅开发期使用

初版至少支持环境变量；增强版支持 Windows Credential Manager。

### 8.3 配置分层

配置分三层：

1. `secret config`
- 密钥，只存在内存

2. `runtime config`
- 可落库或配置文件
- 包括模型、超时、重试、白名单、限流阈值等

3. `derived config`
- 运行时推导配置
- 例如本次任务采用的模型、本次会话键等

优先级建议：

`环境变量 > 本地配置文件 > SQLite settings 表默认值`

### 8.4 飞书侧安全策略

- 只处理明确配置的事件类型
- 初版只响应文本消息
- 群聊默认仅响应 `@机器人`
- 忽略机器人自身消息
- 支持白名单：`chat_id`、`user_open_id`

推荐配置项：

- `ALLOW_GROUPS`
- `ALLOWED_CHAT_IDS`
- `ALLOWED_USER_IDS`

### 8.5 日志与隐私

日志字段建议包含：

- `trace_id`
- `event_id`
- `job_id`
- `conversation_id`
- `chat_id`
- `worker_id`
- `model`
- `attempt`

默认不记录：

- 完整 API key
- 完整 App Secret
- 完整用户正文
- 完整模型输出

可以记录：

- 文本长度
- 哈希摘要
- 有限长度的脱敏片段

## 9. OpenAI 提示词、会话管理与回复策略

### 9.1 产品行为定位

机器人定位为飞书中的聊天式代码助手，职责包括：

- 解释代码
- 分析报错
- 给出修复建议
- 生成小段代码、脚本、SQL、命令
- 帮助整理技术方案
- 在上下文不足时追问必要信息

不允许其：

- 假装读取了本地仓库
- 声称执行过代码
- 编造目录结构、接口返回或测试结果

### 9.2 系统提示词原则

系统提示词应固定，不允许用户覆盖。核心规则：

- 面向开发者交流场景
- 优先给结论，再给原因，再给最小可执行示例
- 信息不足时先追问最小必要信息
- 不编造文件、接口、环境或运行结果
- 默认输出适合飞书 IM 阅读，不要冗长

建议骨架如下：

```text
You are a coding assistant inside Feishu chat.
Answer for developer collaboration in short, practical, high-signal messages.
Prioritize: conclusion -> reasoning -> actionable code or steps.
Do not claim to have accessed files, repositories, or runtime state unless provided in the conversation.
If context is insufficient, ask the minimum necessary follow-up question.
Do not invent APIs, project structures, logs, or test results.
Keep answers concise by default and suitable for instant messaging.
```

### 9.3 上下文策略

上下文构造分三层：

1. `previous_response_id`
- 优先使用 OpenAI 原生会话延续能力

2. 最近消息窗口
- 读取本地 `messages` 表中的最近 8 到 12 条有效消息

3. 会话摘要
- 将较长会话压缩为 `summary_text`
- 保留项目语言、关键报错、已确认约束、已尝试方案和未解决问题

拼装规则：

- 有 `previous_response_id` 时优先续链
- 没有或失效时，改用摘要 + 最近消息窗口 + 当前问题

### 9.4 输入裁剪与追问策略

对于超长日志或代码，机器人不应盲目处理完整内容，而应：

- 截断超长输入
- 提示用户保留最关键片段
- 在上下文不足时只问最关键的一两个问题

例如：

- “把完整报错和触发它的代码片段贴一下。”
- “这是前端、后端还是数据库层的问题？”

### 9.5 模型策略

默认模型：`gpt-5.4-mini`

默认原因：

- 延迟更适合 IM 场景
- 成本更可控
- 适合一般代码问答、报错分析和小段生成

升级到 `gpt-5.4` 的条件：

- 复杂架构设计
- 长链调试
- 多文件代码生成
- 用户明确要求更高质量答案

推荐参数：

- `store: true`
- `reasoning.effort = medium`

## 10. 进程管理、部署与本机运维

### 10.1 启动方式

初版提供三种启动方式：

1. 开发模式
- `bun run dev:gateway`
- `bun run dev:worker`

2. 前台运行模式
- 两个窗口分别运行 gateway 和 worker

3. 后台运行模式
- 使用 Windows 计划任务在登录后自动启动

推荐默认部署方式：Windows 计划任务。

### 10.2 进程守护与优雅退出

每个进程必须支持：

- 启动日志
- 退出码
- 未捕获异常日志
- 优雅关闭

优雅关闭顺序：

1. gateway 停止接收新事件
2. worker 停止领取新任务
3. 正在执行的任务尽量完成或释放租约
4. 刷盘日志
5. 退出

### 10.3 健康检查

每个进程维护独立的健康状态文件：

- `run\gateway.health.json`
- `run\worker.health.json`

内容建议包括：

- `service`
- `pid`
- `version`
- `status`
- `lastHeartbeatAt`

### 10.4 日志策略

- `gateway.log`
- `worker.log`
- 可选 `error.log`

日志格式默认采用结构化 JSON，支持本地开发时切换为可读文本。建议按大小或按日滚动，单文件上限 10MB，保留最近 7 到 14 天。

### 10.5 升级与迁移

推荐升级流程：

1. 停止 gateway 和 worker
2. 备份 SQLite
3. 替换 `bin`
4. 执行数据库 migration
5. 启动新版本
6. 检查 health 和日志

系统需具备：

- `schema_version`
- 启动时 migration 检查
- 失败则拒绝启动并提示回滚

### 10.6 备份与恢复

最小备份策略：

- 每天或每次升级前备份 `app.db`
- 保留最近 3 到 7 份

恢复流程：

1. 停服务
2. 替换数据库文件
3. 重启服务
4. 由 worker 自动恢复任务状态

## 11. 测试、验收标准与实施阶段

### 11.1 测试分层

1. 单元测试
- 会话键生成
- 消息清洗
- 去重判断
- 重试退避计算
- 限流判断
- 配置加载与覆盖优先级

2. 集成测试
- gateway 入队
- worker 抢任务
- SQLite 状态流转
- 重试与投递恢复

3. 适配器测试
- 飞书客户端
- 长连接事件适配
- OpenAI Responses API 封装

4. 端到端测试
- 使用测试飞书应用、测试群和测试 OpenAI Key 验证真实链路

### 11.2 关键验收场景

- 单聊发送代码问题，机器人正常回复
- 群聊未 `@机器人` 时不回复
- 群聊 `@机器人` 后正常回复
- 同一消息重复投递时不重复回复
- 同一用户连续发送多条消息时按顺序处理
- OpenAI 超时后任务进入重试
- 飞书回写失败后只重试投递
- worker 崩溃后租约过期任务可恢复
- `previous_response_id` 失效时可回退到本地上下文
- 超长输入时能提示用户裁剪内容

### 11.3 验收标准

功能验收：

- 能在飞书单聊中稳定回答代码问题
- 能在群聊中仅对 `@机器人` 作出响应
- 能保留单聊和群聊中的独立上下文
- 能在本地数据库中追踪消息、任务、投递和错误状态
- 能在 OpenAI 或飞书临时失败时自动重试
- 能在进程重启后恢复未完成任务

质量验收：

- 同一飞书消息不会产生重复回复
- 同一会话的回复顺序正确
- 日志不包含明文 API key 和 App Secret
- 配置修改后重启可生效
- 普通重启不会丢失会话状态

体验验收：

- 回复默认简洁，适合飞书阅读
- 上下文不足时主动追问
- 不假装读取本地仓库
- 错误提示对用户可理解，不暴露内部堆栈

### 11.4 非功能目标

- 普通请求端到端中位响应时间：小于 8 秒
- 复杂请求端到端响应时间：小于 20 秒
- 本地单机稳定 OpenAI 并发：2
- 重复回复率：0
- 因普通重启导致的任务丢失率：0

### 11.5 分阶段实施计划

#### M1：最小可用链路

- 建项目骨架
- 建 SQLite schema
- 接飞书长连接
- 收消息并入队
- worker 调 OpenAI 并回飞书
- 只支持文本消息
- 单聊优先

目标：打通主链路。

#### M2：稳定性增强

- 去重
- 重试
- lease 恢复
- delivery 解耦
- 结构化日志
- health 文件
- 群聊仅响应 `@机器人`

目标：从能跑提升到可靠。

#### M3：会话质量增强

- `previous_response_id`
- 本地历史窗口
- 会话摘要
- 追问策略
- 输入长度控制
- 回复策略优化

目标：从会答提升到更像代码助手。

#### M4：运维与发布增强

- Windows 计划任务启动
- 配置文件规范化
- 备份脚本
- migration 流程
- 清理任务
- 排障文档

目标：从开发环境服务提升到长期本机运行服务。

## 12. 建议的配置项

建议初版至少支持以下配置：

```text
OPENAI_API_KEY=
FEISHU_APP_ID=
FEISHU_APP_SECRET=

APP_ENV=production
APP_DATA_DIR=%LOCALAPPDATA%\FeishuCodexBot\data
APP_LOG_DIR=%LOCALAPPDATA%\FeishuCodexBot\logs

DEFAULT_MODEL=gpt-5.4-mini
OPENAI_REASONING_EFFORT=medium
OPENAI_TIMEOUT_MS=30000

JOB_POLL_INTERVAL_MS=1000
JOB_LEASE_DURATION_MS=120000
JOB_MAX_ATTEMPTS=4

ALLOW_GROUPS=true
MENTION_REQUIRED_IN_GROUP=true
ALLOWED_CHAT_IDS=
ALLOWED_USER_IDS=

MAX_INPUT_CHARS=12000
CONVERSATION_WINDOW_SIZE=10
PER_USER_RPM=10
GLOBAL_OPENAI_CONCURRENCY=2
DELIVERY_CONCURRENCY=2
```

## 13. 结论

本设计选择了一条适合个人或小范围内部使用的本地化实现路径：以飞书企业自建应用为入口，采用长连接接收消息，以双进程本地 Node.js 服务进行解耦，用 SQLite 作为系统状态中心，通过 OpenAI Responses API 提供代码问答能力，并通过清晰的调度、重试、上下文和安全策略保证可维护性。

初版应优先完成 M1 和 M2，以先建立稳定主链路和恢复能力；在系统稳定后，再逐步增强上下文质量和本机运维能力。
