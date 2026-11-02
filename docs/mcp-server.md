# 本地 MCP Server

`packages/mcp-server/` 提供本地只读 MCP Server。它读取 Lake Catch 的本地设计资产库，把真实同步得到的文档、节点、资源和上下文提供给 Codex。

## 启动

```bash
pnpm --filter @lake/mcp-server start
pnpm --filter @lake/mcp-server test
```

可以用 `LANHU_STATE_PATH` 覆盖状态文件路径，默认路径为 `~/Library/Application Support/com.lake.catch/state.json`。

## 工具

```text
list_design_documents
get_design_document
get_node_tree
get_node
get_design_specs
get_current_implementation_context
get_implementation_context
list_assets
get_asset
list_design_contexts
create_design_context
get_design_context（支持 maxDepth / maxNodes 限制）
```

`get_current_implementation_context` 是日常调用入口，不需要 `documentId`，会自动选择最近一次同步的设计稿；需要局部模块时可以传 `contextId`。底层 `get_implementation_context` 仍支持显式传入 `documentId` 或 `contextId`。响应包含页面目标平台和单位、视口宽度/内容高度、滚动属性、节点层级、边界、文字、样式、资源可用性、可信度、截断状态和实现注意事项。

这个接口是**框架无关的设计输入接口**，不是代码生成器。它不会指定或生成 React、Jetpack Compose、SwiftUI、UIKit、Android XML 或其他实现代码；AI 工具应根据 `target.platform`、`target.designUnit`、来源可信度以及用户的明确指令选择目标平台和框架。

工具返回应包含来源 URL、project/image 标识、同步版本、历史版本数量、node-id、availability、confidence 和字段缺失说明。

## MCP 资源

除工具外，Server 还实现了 MCP Resources：

```text
lake://implementation-context/current
lake://design-documents
lake://design-document/{documentId}
```

`lake://implementation-context/current` 是 Codex 资源面板和 AI 工具读取当前设计稿的首选入口；它返回与 `get_current_implementation_context` 相同的框架无关结构化数据。`resources/list` 会列出当前设计稿资源，`resources/read` 会读取资源内容。

## 数据语义

- `confirmed`：来自已解析Lake设计 JSON 的字段。
- `partial`：响应中存在但无法完整映射的字段。
- `candidate`：页面诊断或启发式提取结果，不能作为实现依据。
- `unknown/unavailable`：当前接入方式未取得。

MCP 不把Lake HTML、WebView DOM 或长图直接交给 Codex 作为设计图层树。`get_design_specs` 只有在节点字段来自真实 JSON 时才返回确认规格，否则必须保留状态。

## 当前边界

- API/JSON 链路完成前，节点树可能为空；这是准确状态，不是要用 DOM 候选填充的缺口。
- 桌面应用创建的 DesignContext 保存在同一个 `state.json`，MCP 优先读取持久化 context；`create_design_context` 仍保留当前进程内存模式，兼容直接通过 MCP 创建的临时 context。
- `get_design_context` 和实现上下文默认按当前文档实际节点数读取，默认深度为 64 层；调用方可以显式传入 `maxNodes`/`maxDepth` 作为性能边界。显式限制触发时，返回同时包含扁平节点、树形节点、关联资源、缺失 node-id 和 `truncated` 状态，并标明 `truncation.nodeLimit`/`truncation.depthLimit`。
- `get_current_implementation_context` 是 AI 工具的首选入口；底层 `get_implementation_context` 仍可用于显式指定 `documentId` 或 `contextId`。它把实现所需的页面目标、节点层级、样式、文字和资源引用整理为单次响应，并保留 `sourceRef`、`confidence`、`availability` 与 `warnings`，避免把候选数据误当成已确认设计规格。
- Codex 的“导入 MCP”只负责写入 MCP 配置，不会复制应用本身。分发 `.app` 时应把 `Lake Catch.app` 放入 `/Applications`，然后重启 Codex；应用内的“添加到 Codex”会优先写入当前 `.app` 内置的 MCP Server 路径。
- `target.platform` 只表示设计稿当前的平台选择（例如 `android`、`ios`、`web`），不表示应该使用哪一个 UI 框架；`target.designUnit` 只表示当前单位候选。`viewportSource`、`contentHeightSource` 和 `scrollableSource` 用于说明字段来自平台探针、根画板或推导结果。
- `implementationGuidance` 只描述如何解释设计数据和可信度边界，不承担平台代码生成职责。HTML 预览脚本位于 `examples/ai-implementation/`，仅用于验证 MCP 数据，不是产品内置生成器。
- 对历史状态中来自 `lake-json`、类型包含 `text` 但 `text` 为空的节点，MCP 会使用该节点的 `name` 做向后兼容归一化；新同步仍由桌面端解析器直接写入正文。
- 整页 `get_implementation_context` 会返回文档内全部资源记录，即使部分历史节点还没有建立资源 URL 关联；这类资源会保留 `candidate-only` 或 `review` 状态，局部 context 仍只返回能够确认属于选区的资源。
- 节点会保留 `confirmed/candidate` 与 `available/candidate-only` 标记，来源信息位于响应的 `source` 字段，不会把诊断候选伪装成已确认设计数据。
- context 会记录创建时的 `documentSyncedAt`。如果同一文档后来重新同步，`list_design_contexts` 和 `get_design_context` 会返回 `stale: true`，调用方应重新选择图层创建新 context。
- 资源工具先返回本地引用、来源、密度和下载策略，资源下载器完成后再提供实际文件。资源记录还会包含 `downloadStatus`、`checksum`、`byteSize`、`mimeType` 和 `referenceCount`。`referenceCount` 用于识别同一源 URL 的多处图层引用。明确为 `mdpi`/`hdpi` 的资源会标记为 `skip-density-variant`；未知密度会标记为 `review`，不会被自动下载。缓存命中会校验本地文件字节数和 checksum；缓存读写失败只会作为同步 notes 返回，不会阻断设计 JSON 保存。
- `list_assets`、`get_asset` 和 `get_design_context` 会额外返回资源 `availability` 与 `confidence`：`available` 表示本地路径可读，`missing` 表示路径已失效，`remote-only` 表示只有远程来源，`skipped` 表示按密度策略跳过，`review` 表示需要人工确认，`candidate-only` 表示仅来自诊断候选。
- 启动器当前依赖 Node 26+ 的 TypeScript 类型擦除能力。

## 连接诊断导出

桌面应用的“连接诊断”按钮会生成 `lake-catch-connection-diagnostic.json`。该文件用于排查 WebView、页面路由、API 同步阶段、设计数据规模、资源状态和上下文版本问题，不是设计数据导出接口。

诊断导出会脱敏 URL 查询值并明确标记 `confirmed` 数据边界；不包含 Cookie、Token、密码、原始 API 响应、完整页面正文或完整设计 JSON。提交诊断文件前仍应检查页面标题、项目标识和本地路径等环境信息是否符合团队的共享范围。

“导出日志”生成 `lake-catch-diagnostic-log.json`，仅包含当前应用会话的状态变化和最近 10 次同步摘要，不写入 `state.json`。日志同样不包含凭据、原始响应、页面正文或未脱敏的 URL 查询值。

