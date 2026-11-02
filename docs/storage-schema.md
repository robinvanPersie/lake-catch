# 本地存储说明

## 1. 当前实现

当前仍使用 Tauri 应用数据目录中的 `state.json`，先完成真实 API/JSON 链路，再迁移 SQLite 和独立资源文件。这样可以复用现有恢复、删除和同步历史逻辑，不需要从头重写。

默认 macOS 路径：`~/Library/Application Support/com.lake.catch/state.json`

## 2. 存储原则

- 保存标准化设计数据，不保存账号密码。
- Cookie/token 只在同步进程内存中使用，不写入状态、日志或错误详情。
- 原始Lake API 响应默认不长期保存。
- 预览、切图和资源保存为文件，并由设计文档通过 `localPath` 引用；远程来源保留在 `sourceUrl`，不保存请求凭据。
- 每个字段带来源和可信度，避免 candidate 被误当 confirmed。
- 同步由用户主动触发，只保存用户有权限取得的内容。

## 3. 文档结构

每份 `DesignDocument` 至少包含：`id`、`provider`、`sourceUrl`、`title`、`syncedAt`、`syncVersion`、`revisions`、`adapterVersion`、`capabilityReport`、`pageIds`、`rootNodeIds`、`nodes`、`assets` 和 `measurementCandidates`。当前文档保存最新版本，`revisions` 保留最近 10 次同步摘要，`revisionSnapshots` 保留最近 10 次同步的完整节点、资源和测量候选快照，以支持本地历史版本查看。升级前创建的旧文档会在下一次同步时自动补建旧版本快照。

每个 `DesignAsset` 可以带有 `density` 和 `downloadPolicy`：`skip-density-variant` 表示明确为 `mdpi`/`hdpi`、不进入下载队列；`download-candidate` 表示明确为其他密度、可进入后续下载队列；`review` 表示无法确认密度、不得自动下载。`2x` 等缩放标识不会自动映射成 `hdpi`。

`measurementCandidates` 仅用于诊断，不是 confirmed 规格。

## 4. 节点来源规则

`nodes` 只允许写入从Lake设计 JSON 解析出的节点，或明确标记为诊断候选且不参与正常节点查询的记录。DOM 页面 UI 元素、长图摘要、标注面板数字不得混入 confirmed 图层树。节点应保留 `source.nodeLocator`，便于定位原始 JSON 来源。

## 5. 目录规划

```text
~/Library/Application Support/com.lake.catch/
├── lanhu-bridge.db
├── documents/<document-id>/
│   ├── preview/
│   ├── assets/
│   └── exports/
├── contexts/
├── logs/
└── settings.json
```

`exports/` 只放用户主动导出的脱敏诊断或设计数据，不默认保存完整原始响应。

桌面端连接诊断导出使用浏览器下载，不自动写入状态文件。诊断文件只保存统计和脱敏状态：URL 查询值被替换为 `<redacted>`，不包含 Cookie、Token、密码、原始 API JSON 或页面正文；它可以作为排障附件，但不作为 MCP 的设计数据源。

桌面端日志导出也是用户主动触发的浏览器下载，文件名为 `lake-catch-diagnostic-log.json`。日志只保留当前会话的状态变化和最近同步摘要，不进入 `state.json`，也不保存凭据或原始响应。

## 7. macOS 交付构建

根目录提供 `pnpm build:desktop:arm64`，用于在 Apple Silicon 主机生成 `aarch64-apple-darwin` release binary 和 macOS `.app`/DMG；如果当前环境的 `hdiutil` 不可用，可使用 `pnpm build:desktop:arm64:app` 只生成 `.app`。未配置 Apple Developer 证书时，产物只能使用 adhoc 签名；正式分发前必须配置 Apple Developer 签名、公证和 Gatekeeper 验证流程。

## 6. 生命周期

- 同一 `projectId/imageId` 再次同步时创建新版本，默认保留最近版本。
- 删除文档不删除无关同步历史。
- 资源按 checksum 去重。
- 资源记录包含 `downloadStatus`、`checksum`、`byteSize`、`mimeType` 和 `referenceCount`；`referenceCount` 表示同一源 URL 在当前设计 JSON 中被多少个图层引用。
- 缓存命中必须同时通过本地文件存在、字节数和 SHA-256 校验；校验失败时删除该缓存索引并重新下载。
- 应用提供资源缓存检查：移除指向不存在文件的缓存索引，并可在确认后删除 `documents/*/assets` 中未被当前文档引用的孤立文件。
- 状态文件先写临时文件再原子替换。
- 失败同步保留阶段、错误类别和脱敏摘要，不保留凭据。

