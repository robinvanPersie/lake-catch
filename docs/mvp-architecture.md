# Lake Catch：产品形态与 MVP 架构

状态：架构重定向已确定，API/设计 JSON 采集是主链路

日期：2026-10-23

## 1. 产品定义

Lake Catch 是一个 macOS 本地Lake设计数据采集器和 MCP 桥接工具。它使用用户已经登录的Lake会话，调用Lake的项目/页面接口取得设计 JSON，再将图层树、文字、样式、资源、切图和评论保存为本地设计资产。

它解决的问题是：让 Codex 能按节点和上下文查询真实设计数据，而不是让 Codex 读取Lake网页源码或一张长图。

### 不再采用的主假设

- 不把Lake WebView DOM 当作设计图层树。
- 不用 `performance.getEntriesByType("resource")` 猜测页面是否加载了 JSON。
- 不通过模拟鼠标点击逐个打开标注面板来完成整页采集。
- 不把页面 UI 的数字候选当成已确认设计规格。

这些能力可继续保留为诊断信息或人工排障工具，但不能写入 confirmed 的设计节点数据。

## 2. 用户工作流

### 2.1 登录和打开设计稿

1. 用户启动 Lake Catch.app。
2. 用户在内置 WebView 中登录Lake并打开有权限的设计稿。
3. 应用从当前 URL 解析 `project_id`、`image_id`、`team_id` 等路由信息。
4. 应用短暂读取当前 WebView 的 Cookie/localStorage token，仅用于本次请求。

第一版继续使用内置 WebView，避免先要求用户安装扩展。协议层已经预留 Chrome/Edge/Brave/Safari 扩展与 Native Messaging 的版本化消息边界，以便后续复用外部浏览器登录态；真实扩展端仍不属于当前 MVP。

扩展协议约束：所有消息都带有协议名、协议版本、`requestId` 和发送时间；支持握手、页面快照、同步请求/响应、能力状态和错误消息。协议不传输密码，凭据不进入共享消息类型，也不允许写入日志或持久化状态。扩展发来的消息必须先经过运行时守卫，未知版本、未知类型或缺少 `requestId` 的消息直接拒绝。

协议包还提供传输无关的会话状态机：只有完成 `extension.hello` 后，页面快照和同步响应才会被接受；协议错误会清理连接状态。它不负责打开端口、读取浏览器 Cookie 或调用设计 API，这些职责留给后续的扩展宿主和现有桌面适配器。

Native Messaging 传输层使用 4 字节小端无符号长度前缀加 UTF-8 JSON 消息体，单条消息限制为 1 MB。协议包提供可增量接收的分帧解码器，网络/进程输入被截断时会保留未完成帧，遇到超限或非法 JSON 则返回协议错误。`@lake/browser-extension` 只实现浏览器无关的扩展核心和端口适配器，页面提供器和发送器由 Chrome/Edge/Brave/Safari 适配层注入，不在共享包内直接读取 DOM 或凭据。Manifest V3 目录只是接入骨架，尚未注册 Native Messaging 宿主。

### 2.2 同步完整设计数据

1. 用户点击“同步当前页面”。
2. Rust Lake适配器调用项目页面接口。
3. 从响应中解析 `data`/`result` 和 `json_url`/`jsonUrl`。
4. 下载设计 JSON，解析 `artboard.layers` 及其资源、切图和评论。
5. 将原始字段映射为统一 `DesignDocument`、`DesignNode` 和 `DesignAsset`。
6. 在界面显示采集进度、能力状态、节点数量和错误分类。

“同步整页”表示抓取该设计页的结构化图层树，不表示把页面渲染成一张固定高度的图片。长页面的高度由图层坐标和内容边界计算，预览区域支持滚动。

### 2.3 本地选择上下文

1. 用户在本地图层树或预览中选择根节点。
2. 应用生成 `DesignContext`，包含根节点、子树、相关资源、评论和来源信息。
3. Codex 通过 MCP 按 context、node-id 或文档查询。

Lake页面中的“选中整页”只用于确定当前同步对象；后续节点选择不依赖模拟Lake鼠标事件。

## 3. 系统边界

```text
+---------------------+       +----------------------+
| 内置 WebView         |       | Lake API 适配器       |
| 登录、打开链接、凭据 | ----> | 路由、请求、JSON 解析  |
+---------------------+       +----------+-----------+
                                          |
                                          v
                               +----------------------+
                               | 本地设计资产库        |
                               | 文档、图层、资源、版本  |
                               +----------+-----------+
                                          |
                       +------------------+------------------+
                       v                                     v
             +----------------------+              +----------------------+
             | 图层检查器/预览       |              | 本地 MCP Server       |
             | node-id/context      |              | Codex 查询            |
             +----------------------+              +----------------------+
```

### 3.1 WebView 接入层

职责：登录、打开Lake链接、提供当前 URL/title，以及在同步瞬间提供 Cookie/token。

不负责：解析 DOM 生成设计树、长期保存凭据、保存原始账号信息。

### 3.2 Lake API 适配器

适配器隔离所有Lake协议细节，至少包含：URL 路由解析、Cookie/token 注入、`/api/project/image` 和 `/api/project/images` 请求、`json_url`/`jsonUrl` 解析、418 限流重试、鉴权失败、超时和响应格式错误，以及 `artboard.layers` 递归解析。

适配器输出每个字段的 `availability` 和 `confidence`，避免把Lake版本差异误报为设计稿没有该字段。

### 3.3 本地应用

职责：同步任务编排、进度和错误展示、本地存储、图层检查器、预览、上下文管理和 MCP 生命周期管理。

## 4. 统一数据模型原则

保留现有 `DesignDocument`、`DesignNode`、`DesignAsset`、`DesignContext` 类型，并扩展来源字段：`source.provider`、`source.projectId/imageId/teamId`、`source.apiEndpoint`、`source.nodeLocator`、`confidence` 和 `availability`。

只有来自Lake JSON 且经过 schema 映射的图层、文字、样式和资源才能标记为 `confirmed`。页面 DOM、长图 OCR/数字候选和 UI 元素一律最多为 `candidate`。

## 5. 安全与隐私

- 只允许用户主动点击触发同步。
- 不保存账号密码。
- Cookie/token 只在内存中用于本次请求，日志中只记录是否存在，不记录值。
- 原始 API 响应默认不长期保存；调试导出必须脱敏并由用户主动触发。
- 只同步当前用户有权限访问的项目/页面。

## 6. 技术选择

- Tauri 2 + Rust：桌面能力、WebView、HTTP 适配器和文件存储。
- React + TypeScript：桌面 UI、图层树和预览。
- `reqwest`：Lake API 请求。
- 先继续使用 `state.json` 打通首条真实链路，再迁移 SQLite/文件资源目录。
- MCP 使用本地 stdio，只读工具为主。

## 7. 迁移策略

不从头开发。保留 Tauri 壳、React UI、URL 解析、同步交互、统一模型、MCP 工具接口、状态存储、平台单位模型和预览框架。

调整或降级：结构化页面探针、DOM 节点候选、标注数字候选都改为诊断/兜底，不再作为设计数据主来源。

新增：Rust HTTP 客户端、登录态桥接、API 响应解析、JSON fixture、资源下载、版本化同步和真实图层检查器。

