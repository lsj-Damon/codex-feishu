# 飞书本地聊天式代码助手多张图片支持设计

- 文档日期：2026-04-19
- 文档状态：详细设计
- 关联设计文档：[2026-04-18-feishu-local-coding-assistant-design.md](./2026-04-18-feishu-local-coding-assistant-design.md)
- 关联实施文档：[2026-04-18-feishu-local-coding-assistant-implementation-plan.md](./2026-04-18-feishu-local-coding-assistant-implementation-plan.md)
- 适用范围：飞书单聊与群聊 `@机器人` 的多张图片消息支持

## 1. 设计目标

在当前“飞书消息 -> 本地服务 -> OpenAI -> 飞书回复”的双进程架构上，扩展对**单条飞书消息携带多张图片**的支持，使机器人能够：

- 识别并接收一条消息中的多张图片
- 下载并缓存图片到本地
- 将文本与多张图片共同作为上下文输入给模型
- 在模型支持图片时直接分析图片内容
- 在模型或链路不支持图片时优雅回退

该设计只扩展多模态消息处理，不改变现有 `gateway + worker + SQLite` 总体架构。

## 2. 非目标

以下内容不在本设计范围内：

- OCR 独立服务
- 视频、音频、长文档统一多模态解析
- GUI 图片预览
- 飞书历史消息与图片自动同步到 Codex 界面
- 向量检索、知识库、RAG
- 云端对象存储

## 3. 现状与缺口

当前实现已经具备以下能力：

- 飞书 websocket / webhook 接收事件
- 文本消息入库、入队与回复
- `messages`、`conversations`、`jobs`、`deliveries` 等核心状态表
- M2 的重试与投递恢复
- M3 的上下文窗口、追问和摘要机制

当前图片消息的实际行为是：

- `gateway` 能识别图片类消息事件
- 但只把图片消息转换成占位文本（例如 `[feishu:image]`）
- `worker` 不会下载图片，也不会把图片送进模型
- 策略层只会返回“请把图片内容转成文字”的说明

因此，当前系统并不具备真正的图片理解能力。

## 4. 总体方案

采用“**消息内容块 + 附件元数据表 + 本地缓存 + 多模态上下文组装**”的方案。

核心思路如下：

1. `gateway` 在接收消息时提取文本与所有图片引用，构造成内容块
2. 文本消息仍写入 `messages`
3. 每张图片单独写入一条附件元数据记录
4. `worker` 处理任务时读取附件元数据并下载图片
5. `worker` 构造包含文本块和图片块的多模态上下文
6. OpenAI client 根据当前模型能力决定：
   - 直接发送多图输入
   - 或退回成文本说明

## 5. 数据模型设计

### 5.1 保留现有 `messages` 表

当前 `messages` 表继续保留：

- `content_text`
- `content_json`

其中：

- `content_text` 存消息的可读文本摘要
- `content_json` 存标准化后的内容块结构

一条“文本 + 多张图”的 `content_json` 示例：

```json
{
  "blocks": [
    { "type": "text", "text": "帮我看这几张截图里的报错差异" },
    { "type": "image", "remote_key": "img_v2_001", "status": "pending" },
    { "type": "image", "remote_key": "img_v2_002", "status": "pending" }
  ]
}
```

### 5.2 新增 `message_attachments` 表

建议新增表：`message_attachments`

字段：

- `id`
- `message_id`
- `attachment_index`
- `provider`
- `attachment_kind`
- `remote_key`
- `local_path`
- `mime_type`
- `status`
- `width`
- `height`
- `metadata_json`
- `last_error_message`
- `created_at`
- `updated_at`

字段说明：

- `message_id`：关联 `messages.id`
- `attachment_index`：保留图片在原消息中的顺序
- `provider`：当前固定为 `feishu`
- `attachment_kind`：第一版固定为 `image`
- `remote_key`：飞书 `image_key`
- `local_path`：下载后的本地缓存路径
- `status`：`pending` / `downloaded` / `failed`

约束与索引：

- `UNIQUE(provider, remote_key)`
- `INDEX(message_id, attachment_index)`
- `INDEX(status, updated_at)`

### 5.3 不把图片二进制写入数据库

图片二进制只存放到本地缓存目录，不写 SQLite。

原因：

- 降低数据库膨胀风险
- 清理与保留策略更容易做
- 后续支持 PDF / 文件时可统一复用附件缓存机制

## 6. 运行目录与缓存设计

建议新增缓存目录：

```text
%LOCALAPPDATA%\FeishuCodexBot\
  data\
    app.db
    attachments\
      images\
```

图片命名规则建议：

- `<remote_key>.<ext>`

如果扩展名不明确，先落为 `.bin`，后续根据 mime 修正。

## 7. Gateway 设计

### 7.1 支持的图片消息类型

第一版至少支持：

- `message_type = image`
- `post` / 富文本中的多张图片

### 7.2 Gateway 的职责

`bot-gateway` 需要完成以下动作：

1. 解析消息中的文本块和图片块
2. 提取所有 `image_key`
3. 生成内容块数组
4. 写入 `messages`
5. 写入 `message_attachments`
6. 创建单个 `reply_generation` 任务

### 7.3 内容块格式

内部内容块建议：

```ts
type InboundContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; remoteKey: string };
```

### 7.4 多图顺序

必须保留图片在原消息中的顺序，因为用户经常依赖顺序表达语义：

- 第 1 张：报错截图
- 第 2 张：代码片段
- 第 3 张：运行结果

## 8. Worker 设计

### 8.1 附件下载流程

`assistant-worker` 读取到带图片的消息后：

1. 查询该消息关联的全部 `message_attachments`
2. 对每张图片执行：
   - 若 `status=downloaded` 且文件存在，则直接复用
   - 否则调用飞书 SDK 下载图片
3. 更新附件状态
4. 将下载成功的图片加入上下文构建

### 8.2 下载接口

使用飞书 SDK 图片下载接口，例如：

- `client.im.image.get`

### 8.3 下载失败策略

不建议因为“某一张图失败”就让整个任务失败。

推荐行为：

- 成功的图片继续参与分析
- 失败的图片记录错误
- 回复中明确提示“有部分图片未成功读取”

### 8.4 与现有 M2 重试的关系

区分两类失败：

1. 单张图片下载失败
   - 附件状态标记失败
   - 任务可继续

2. 模型调用整体失败
   - 走现有 M2 重试逻辑

## 9. 上下文构建设计

### 9.1 多模态消息抽象

建议把当前上下文从“纯文本消息列表”升级为“内容块列表”：

```ts
type ConversationContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; localPath: string; mimeType: string; remoteKey: string };
```

### 9.2 一条多图消息的上下文表示

示例：

```ts
[
  { type: 'text', text: '帮我看这几张图里的报错差异' },
  { type: 'image', localPath: '...img_1.png', mimeType: 'image/png', remoteKey: 'img_1' },
  { type: 'image', localPath: '...img_2.png', mimeType: 'image/png', remoteKey: 'img_2' }
]
```

### 9.3 上下文裁剪策略

需要限制：

- 每条消息保留的最大图片数
- 单次上下文中的最大图片总数
- 总输入字节数

推荐参数：

- `MAX_IMAGES_PER_MESSAGE = 4`
- `MAX_IMAGES_PER_CONTEXT = 6`
- `MAX_TOTAL_IMAGE_BYTES = 20MB`

裁剪规则：

- 优先保留最新消息中的图片
- 再保留旧上下文中的文字
- 若图片被裁剪，补一条系统说明

## 10. OpenAI 调用设计

### 10.1 当前问题

当前 OpenAI client 只支持文本：

- 系统提示词
- 文本消息

不能发送图片输入。

### 10.2 多模态输入结构

建议升级为：

```ts
type OpenAiInputItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string };
```

一条多图消息的输入示例：

```json
[
  {
    "role": "user",
    "content": [
      { "type": "input_text", "text": "帮我比较这几张图里的报错差异" },
      { "type": "input_image", "image_url": "data:image/png;base64,..." },
      { "type": "input_image", "image_url": "data:image/png;base64,..." }
    ]
  }
]
```

### 10.3 模型能力回退

如果当前模型通道不支持图片输入，则：

- 不发送图片块
- 返回明确说明：
  - 当前模型通道暂不支持图片分析
  - 请转为文字描述

## 11. 回复策略

多图分析默认结构建议：

1. 先给结论
2. 再按图片顺序逐张分析
3. 最后给综合判断与建议

示例：

- 第 1 张：编译错误
- 第 2 张：配置文件
- 第 3 张：运行日志

若某张图失败：

- 在回复中说明“部分图片未成功读取”

## 12. 参数与限制

建议新增配置：

- `MAX_IMAGES_PER_MESSAGE`
- `MAX_IMAGES_PER_CONTEXT`
- `MAX_IMAGE_BYTES`
- `MAX_TOTAL_IMAGE_BYTES_PER_JOB`
- `IMAGE_CACHE_RETENTION_DAYS`
- `IMAGE_DOWNLOAD_CONCURRENCY`

第一版默认值建议：

- `MAX_IMAGES_PER_MESSAGE = 4`
- `MAX_IMAGES_PER_CONTEXT = 6`
- `MAX_IMAGE_BYTES = 8MB`
- `MAX_TOTAL_IMAGE_BYTES_PER_JOB = 20MB`
- `IMAGE_CACHE_RETENTION_DAYS = 14`
- `IMAGE_DOWNLOAD_CONCURRENCY = 2`

## 13. 数据清理设计

M4 清理脚本后续需要扩展：

- 清理过期附件缓存文件
- 清理失败附件记录
- 清理孤儿缓存文件

保留策略建议：

- 已下载图片：保留 7 到 14 天
- 失败记录：保留 3 到 7 天

## 14. 与 Codex 界面的关系

当前系统不会把飞书里的消息和图片自动同步到 Codex 界面。

现有行为是：

- 飞书消息保存在 SQLite：
  - `raw_events`
  - `messages`
  - `conversations`
- 当前没有 GUI / 会话桥接层去把这些记录映射到 Codex 界面线程

因此：

- **不需要新建一个“飞书项目”才能支持多图**
- **也不会自动在 Codex 界面里加载历史飞书对话**

如果未来要支持“在 Codex 界面浏览飞书历史会话”，那是一个独立功能，需要额外设计：

- 历史会话浏览
- SQLite -> UI 映射
- 附件本地预览

不属于当前多图支持设计范围。

## 15. 分阶段实施建议

### 阶段 A：单图 MVP

- 支持 `image` 消息
- 单条消息只处理第一张图
- 下载并缓存图片
- 模型支持图片时直接分析
- 模型不支持时回退为文字说明

### 阶段 B：多图支持

- 一条消息支持多张图片
- 保留顺序
- 加入总量限制与裁剪

### 阶段 C：富文本与附件增强

- 支持 `post` 中多张图
- 支持图片与文本混合顺序保留
- 支持文件/PDF 统一附件流

## 16. 验证方案

至少覆盖以下场景：

- 单图消息可下载并分析
- 多图消息按顺序分析
- 文本 + 多图消息可正常处理
- 某一张图下载失败时任务部分成功
- 超出图片上限时会截断并说明
- 模型不支持图片时会优雅回退
- 清理脚本不会误删正在使用的附件

## 17. 风险

- 当前 OpenAI 兼容网关不一定支持图片输入
- 多图会显著增加延迟与 token / 带宽开销
- 本地附件缓存会增加磁盘占用
- 图片顺序丢失会导致语义错误

## 18. 结论

要支持多张图片，系统必须从“单文本消息模型”升级为“多内容块消息模型”。

这不是简单放开图片事件就能完成的功能，而是涉及：

- 入库模型
- 附件下载缓存
- 多模态上下文
- 模型调用格式
- 回退策略
- 附件清理

因此，建议把它作为当前设计后的下一轮功能扩展单独实施，而不是继续塞进当前 M1 到 M4 范围中。
