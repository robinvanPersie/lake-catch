# Lake Catch

一个面向 macOS 的本地Lake设计数据采集器和 MCP 桥接工具。

## 产品定位

Lake Catch 的核心不是把Lake网页嵌入桌面窗口，也不是从页面 DOM 猜测设计稿，而是把用户主动选择的Lake设计页同步为本地、可查询的结构化设计资产：

```text
Lake登录态 + 设计稿链接
    -> Lake接口 / 设计 JSON
    -> 图层、文字、样式、资源、切图、评论
    -> 本地图层库和检查器
    -> MCP 按 document / node / context 查询
    -> Codex 在业务项目中实现 UI
```

产品不保存账号密码。Cookie 和 token 只作为一次同步请求的短暂凭据，不写入同步记录、日志或设计文档。

## 当前状态

- 已完成：Tauri 2 + React 桌面壳、内置Lake WebView、登录和深链接打开、主动同步交互、同步历史、平台单位识别、诊断报告、本地 MCP 骨架。
- 已验证：当前页面可以识别Lake路由参数；页面长图和 DOM 候选可以用于诊断，但不是可信的设计图层树。
- 正在调整：从“页面探针主导”迁移到“Lake API/设计 JSON 主导”。
- 当前真实设计节点、样式和资源仍不能以 `partial` 结果冒充已确认数据，必须等 API JSON 解析链路完成后再展示为 confirmed。

产品定义见 [产品定义](docs/product-definition.md)，详细架构见 [MVP 架构与实施计划](docs/mvp-architecture.md)，执行顺序见 [开发计划](docs/development-plan.md)。

## 本地开发

需要 Node.js、pnpm 和 Rust/Tauri 工具链：

```bash
pnpm install
pnpm check
pnpm --filter @lake/desktop dev
```

完整桌面调试和构建：

```bash
pnpm --filter @lake/desktop tauri dev
pnpm --filter @lake/desktop tauri build
```

启动本地 MCP：

```bash
pnpm --filter @lake/mcp-server start
pnpm --filter @lake/mcp-server test
```

## 给 AI 工具的实现入口

AI 工具接入本地 MCP 后，优先调用 `get_current_implementation_context`，无需用户提供工具参数或记忆 `documentId`；它会自动读取最近一次同步的设计稿。用户在桌面检查器中创建局部模块后，AI 可以自行使用 `contextId`，也可以继续读取整页设计。

```json
{
  "name": "get_current_implementation_context",
  "arguments": {}
}
```

返回的 `data` 包含 `target`（平台、单位、视口和滚动属性）、`nodes`（边界、文字、样式和父子关系）、`assets`（本地/远程可用性）、`warnings` 和 `implementationGuidance`。AI 应先检查 `status`、`truncated`、`stale`、`confidence` 和 `availability`，再生成业务项目代码；`candidate` 或 `partial` 字段只能作为待确认信息。

MCP 只提供框架无关的设计输入，不负责生成某一种代码。你可以在调用 AI 工具时明确要求生成 Android Jetpack Compose、Android XML、iOS SwiftUI、UIKit、React 或其他目标；AI 工具应根据 `target.platform` 和你的指令选择实现方式。

## 使用边界

- 只同步用户有权限且主动触发的设计稿。
- 不保存Lake账号密码；不把 Cookie/token 写入日志或持久化设计数据。
- 默认同步一个设计页的完整 JSON 图层树；“选择节点”发生在本地检查器中，不需要模拟鼠标逐个点击Lake图层。
- 长图只作为预览/诊断资源，不把它当作完整页面图片实现。
- 无法由Lake响应确认的字段必须返回 `partial`、`candidate` 或 `unknown`，不能静默补值。

