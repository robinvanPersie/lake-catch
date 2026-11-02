# Lake Catch：重定向后的开发计划

状态：第一版 MVP 已完成；V2 进入交互式设计检查工作台开发，P6 浏览器扩展能力继续暂缓

日期：2026-10-23

## 1. 计划原则

1. 先打通一条真实单页 API 链路，再扩展完整 UI。
2. 保留现有桌面壳、MCP 和存储，避免无必要重写。
3. 先用 fixture 测试解析器，再用真实Lake页面验收。
4. API JSON 是 confirmed 设计数据的唯一主来源。
5. DOM/长图/数字候选只用于诊断，不能混入设计节点树。
6. 每个阶段都必须有可运行结果和明确失败状态。

## 2. 当前基线

已完成或可复用：Tauri 2 + React 桌面壳、内置 WebView、Lake URL 识别、深链接打开、同步交互、平台单位识别、`DesignDocument`/`DesignNode`/`DesignAsset`/`DesignContext`、`state.json`、只读 MCP 工具、页面诊断和长图预览。

当前结论：页面 DOM 不是可靠设计数据源；结构化探针为 `partial/failed` 时不能继续包装为完整图层树。

## 3. 阶段计划

### P0：架构和安全边界重定向

产出：架构、能力报告、存储和 MCP 文档统一口径。

验收：所有文档明确 API/JSON 主链路、凭据边界和 candidate/confirmed 区别。

### P1：单页Lake API 采集

任务：实现 URL 路由解析；在 Rust 中读取 WebView 当前会话凭据；增加 `reqwest` 客户端；请求 `/api/project/image`，必要时补充 `/api/project/images`；处理 `data`/`result`、`json_url`/`jsonUrl`、418、401/403、超时和空响应；记录脱敏阶段和错误分类；验证 `json_url` 可访问性。

完成标准：点击一次同步可以返回“API 响应成功 / JSON 下载成功 / 明确失败原因”，且日志无 Cookie/token。

### P2：设计 JSON 解析器（已完成）

任务：添加 artboard/frame/group/text/image/shape/comments/slices fixture；递归解析 `artboard.layers`；映射 frame、可见性、opacity、rotation、圆角、fills、borders、shadows、blur；映射文字属性；映射资源/切图引用；保留 node locator；未知字段标记 `unknown`。

当前进展：真实单页 JSON 已递归得到图层、父子关系、边界、文字、可见性和深度；已增加常见文字/颜色/透明度/旋转/圆角/边框样式映射，以及图片资源 URL 候选索引。部分真实 `textLayer` 的正文只存在于 `name` 字段，解析器已按文本类型回退读取；MCP 还对修复前保存的旧节点做兼容归一化。资源解析支持直接字段和嵌套的 `image`/`asset`/`resource`/`fill` URL 字段，下一次真实同步会重新绑定可用资源。预览支持长页面、2x 坐标缩放和可用图片 URL 的直接展示。资源候选已先按密度分类：明确的 `mdpi`/`hdpi` 标记为跳过，其他明确密度标记为下载候选，无法确认密度的资源标记为待复核；`@2x`/`scale: 2` 不直接等同于 `hdpi`。当前已将可下载候选落盘到本地文档资源目录，并把 `localPath` 返回给设计模型。

完成标准：fixture 稳定得到节点树、文本、样式和资源索引；真实页面至少得到一个 `confirmed` 根节点及可验证子节点。

### P3：同步版本和本地资产库

先在 `state.json` 中保存真实节点树和同步版本，再迁移 SQLite/文件资源。增加采集阶段、版本号、节点/资源计数、错误摘要、预览和资源下载，并用 checksum 去重。资源下载必须先经过密度策略：跳过 `mdpi`/`hdpi`，仅下载明确的其他密度，未知密度保持待确认；当前已完成按策略下载、25 MB 单文件限制、临时文件提交、checksum 缓存、MIME 校验、失败 notes 和资源管理 UI。缓存读写失败会降级为同步 notes，不会丢弃已成功取得的设计 JSON；下一步进入资源质量检查和版本清理。

完成标准：关闭应用后仍能查看结果；再次同步能区分版本和失败阶段。当前已保存最近 10 次版本摘要，并提供资源缓存检查和孤立文件清理入口。

### P4：图层检查器和 DesignContext

展示真实图层树；预览按图层坐标支持长页面滚动；节点详情显示 frame、文字、样式、资源和评论；支持 node-id 链接、根节点选择和 context 创建；明显显示 `partial/candidate`。

当前进展：已接入真实 JSON 图层树和节点详情面板。检查器只读取 `lake-json:` 来源节点，支持根节点展开、父子关系、可见性、边界、文字、样式字段、资源 URL 和来源定位；同步新稿及切换历史记录时会重新绑定当前文档节点。现在可以从当前选中图层创建包含完整子树的 DesignContext，context 与文档一起保存到 `state.json`，支持删除，并由 MCP 重启后读取。MCP 返回 context 时支持节点树、资源关联、来源标记和深度/数量限制；重新同步同一文档后旧 context 会标记为 stale。

完成标准：从整页同步结果中选择内部模块生成稳定 context，不需要逐个点击 Lake 标注；应用重启后 MCP 仍能通过 context ID 查询节点子树。

### P5：MCP 接入真实数据和 AI 实现上下文

保留现有 9 个只读工具，将返回切换到真实解析节点；增加深度、字段大小和资源限制；每次响应附来源 URL、同步版本、node-id、availability 和 confidence；增加 fixture 和端到端 stdio 测试。当前 MCP 已返回同步版本/历史版本数量，节点带 `confirmed`/`candidate` 与 `available`/`candidate-only`，资源会实际检查 `localPath` 并返回 `available`、`missing`、`remote-only`、`skipped`、`review` 或 `candidate-only`。

当前进展：除 document / node / context 查询外，已增加 `get_implementation_context` 单次入口。它支持按持久化 `contextId` 读取局部模块，也支持按 `documentId` 读取整页，并返回平台单位、视口与页面滚动属性、紧凑节点树、资源可用性、可信度、警告和实现指导；节点/深度截断会分别记录原因。MCP smoke 测试覆盖 context 模式和 document 模式。真实新闻详情页已验证：506 个节点、92 个文本节点、全部来自 `lake-json`，整页响应未截断；当前 `partial` 仅表示平台单位和页面尺寸探针尚未确认。页面尺寸缺少平台探针时，现在回退到根画板的真实 bounds，并明确标记 `root-artboard` / `derived-from-artboard` 来源，不伪装为平台已确认值。

已增加 `examples/ai-implementation/generate.mjs` 独立验收入口：它通过 MCP 读取实现上下文，按根画板坐标系生成可滚动 HTML 页面，保留缺失资源占位，并在页面内显示 status、平台单位、视口、资源 availability 和 warnings。当前真实新闻详情页生成结果为 `375 x 3481` CSS 像素、506 个节点和 92 个文本节点；生成器不使用整页长图作为实现来源。该 HTML 仅用于验证 MCP 数据，不代表产品需要内置 React、Compose、SwiftUI 或其他代码生成器。

桌面设计预览已修正根画板坐标归一化：根节点的 API `x/y` 可能是整个设计画布中的绝对坐标，子节点则是画板内坐标；预览现在将根画板固定到 `(0, 0)`，并以根画板高度限制画布，避免少量离群坐标把页面下方撑成无内容的白板。

真实同步复验已完成：2026-10-26 的同步将该页面版本提升到 3，仍得到 506 个节点；去重后得到 17 个带真实 URL 的资源。资源密度未知时保持 `review`，不猜测为 `mdpi`/`hdpi`；同一 URL 的多次图层引用已在 Rust 资源提取阶段去重，并通过 `referenceCount` 保留引用次数，最高一个资源被 6 个图层引用。桌面端同步面板现在会显示资源总数、带 URL 数量、按密度跳过数量和待复核数量。MCP 实现上下文已同步使用去重后的 17 个资源。

AI 实现验收入口现在同时生成 HTML 和 `implementation-context.json`。JSON manifest 包含目标画布、节点树、文本/样式、资源 availability、引用次数、可信度、截断信息和实现告警，可直接作为 AI 编码工具或业务项目渲染器的机器输入；HTML 仅作为视觉校验结果。

资源可用性已与下载策略分离：带 `sourceUrl` 但未落盘的资源返回 `remote-only`，本地缓存可读时返回 `available`，明确跳过密度变体时返回 `skipped`，没有确认 URL 时才返回 `candidate-only`。当前真实页面的 17 个资源均为 `remote-only`，因此 AI 可以直接使用 URL，同时仍能看到其密度策略为 `review`。

完成标准：AI 工具可以直接调用一个 MCP 工具获得实现 UI 所需的结构化上下文，缺失字段不会被编造；`list_design_contexts` 能列出当前本地上下文；上下文不完整或过期时响应能明确要求重新选择/同步。

当前闭环边界已明确：Lake 只负责同步和提供框架无关的设计数据；目标平台与实现框架由用户在 AI 工具中指定。真实用户已经完成桌面应用 -> MCP -> AI 工具 -> 页面实现的闭环验证，第一版 MVP 验收完成。由于输入是静态设计稿，动态交互、动画和状态切换不属于本版验收范围；后续增强应优先关注资源导出质量、节点定位和更高保真的实现辅助，不在 Lake 内新增平台代码生成器。

### P6：连接诊断和扩展协议原型（暂缓）

当前先完成连接诊断、脱敏导出和端到端验收基线，再逐步评估 Chrome/Edge/Brave 扩展与 Native Messaging。内置 WebView 是当前默认连接方式；扩展模式不能改变 API/JSON 是 confirmed 数据唯一来源的边界。

当前进展：能力报告面板已提供“连接诊断”和“导出日志”。连接诊断只包含应用/适配器版本、脱敏页面地址、浏览器窗口状态、同步阶段、HTTP 状态、JSON 大小、节点/资源统计、平台单位候选、文档版本和上下文状态；日志只保留本次运行的状态变化和最近同步摘要。Cookie、Token、密码、原始 API JSON、页面正文和 URL 查询值不会写入导出文件。

当前已验证：在 Apple Silicon 主机上可生成原生 `aarch64-apple-darwin` release binary 和 `.app`；构建产物为 arm64 Mach-O。正式签名仍需要 Apple Developer 证书、Team ID 和公证凭据；当前本机产物仅为 adhoc 签名。DMG 需要完整 macOS `hdiutil` 环境，本次执行环境的 `hdiutil` 返回“设备未配置”，因此已用仅 `.app` 目标完成产物验证。

已完成：`@lake/protocol` 增加版本化扩展消息信封、握手、页面快照、同步、能力状态和错误消息类型，并提供拒绝未知版本、未知消息类型和缺少 `requestId` 的运行时解析入口。新增传输无关的 `ExtensionProtocolSession`，Native Messaging 4 字节小端长度前缀的组帧/分帧工具，以及 `@lake/browser-extension` 浏览器无关核心和端口适配器，支持握手、页面快照请求响应和连接错误处理；同时加入未安装的 Manifest V3 骨架。浏览器 API、Native Messaging 宿主和真实页面快照实现仍未接入。

待完成：真实扩展端、Native Messaging 宿主、跨浏览器连接验收、正式签名与公证和最终交付包。当前主线先不扩展浏览器插件，优先验证桌面应用 -> MCP -> AI 工具 -> 业务项目实现的闭环。

## 6. 第二版开发计划：交互式设计检查工作台

V2 的目标不是增加代码生成器，也不是解析动画，而是补齐设计稿检查、节点定位和资源使用体验，使 Lake Catch 从“同步后查看结构化数据”升级为“可以在本地画布中检查并选择设计数据”。

### V2-P1：交互式画布基础

任务：使用已确认的 `DesignNode` 和 `DesignAsset` 构建本地画布；统一根画板坐标系；支持缩放、平移、滚动、适配宽度和返回原始比例；保持长页面性能稳定。

验收：不同尺寸和不同页面高度的设计稿都能正确显示；画布坐标与节点详情中的 frame 一致；不存在依赖某一张设计稿尺寸或标题的特殊判断。

### V2-P2：节点命中和重叠选择

任务：为可见节点建立命中索引；点击画布位置返回候选节点；按照 z-order 处理重叠图层；支持继续选择被遮挡节点；选中节点显示边框和来源状态。

验收：点击文字、图片、容器和嵌套节点能够定位到真实节点；重叠节点可以逐层选择；`candidate` 节点不能伪装成 `confirmed` 节点。

### V2-P3：节点详情、上下文和定位链接

任务：将画布选择、图层树选择和详情面板统一为同一个 selection 状态；支持从选中节点创建 context；增加稳定的设计稿/节点定位标识和复制入口；应用重新启动后可恢复最近文档和选择状态。

验收：画布点击、树点击和 MCP 查询能指向同一个节点；定位信息可以在同一份本地文档中恢复；过期或文档版本变化时明确提示重新同步。

### V2-P4：资源检查和 Android 导出准备

任务：在资源面板展示预览、来源 URL、尺寸、密度、引用次数、availability 和下载状态；区分 `res/drawable` 与 `res/mipmap` 建议；继续跳过 `mdpi` / `hdpi`，不把未知密度误判为可直接导出；提供批量下载或导出前检查。

验收：每个资源都有明确的处理结论；不能下载或密度未知时显示原因；导出结果不会覆盖同名不同内容文件，也不会把整页长图当作单个素材替代图层资源。

### V2-P5：MCP 交互优化和回归验收

任务：增加“当前选中节点”和“当前文档”查询入口；完善分页、深度限制、截断提示和来源链接；为画布选择、context、资源和多设计稿切换增加 fixture 与真实数据回归测试。

验收：用户不需要手动记忆 `documentId` 或 `contextId` 就能让 AI 获取当前选择；整页大文档响应可控；旧版同步数据仍可读取；第一版真实闭环不回归。

### V2 暂不开发

- 浏览器扩展和 Native Messaging 的完整落地；
- 设计稿编辑和回写；
- 动画时间线、原型连线和业务交互状态机；
- Lake Catch 内置 Android、iOS、React、Compose 或 SwiftUI 生成器；
- 云端团队协作。

## 7. V2 里程碑

```text
0.8.0-canvas       本地交互式设计画布
0.9.0-selection    节点命中、重叠选择和统一检查器
0.10.0-locator     节点定位链接和上下文工作流
0.11.0-assets      资源检查和 Android 导出准备
0.12.0-inspection  MCP 交互优化和 V2 回归验收
```

## 8. 不做重写的模块

保留 Tauri 壳、React、URL 解析、同步交互、协议包、设计模型、MCP 工具名、本地状态存储、平台单位模型和诊断页面。

降级 `get_lanhu_structured_data_probe`、DOM 节点候选、标注数字候选和长图摘要，它们只能生成诊断报告或 candidate 字段。

新增 `lanhu_api`、`lanhu_data`/schema parser、登录态桥接、资源下载器和 fixture 测试。

## 9. 第一版版本里程碑

```text
0.1.0-shell       桌面壳、WebView、同步交互
0.2.0-diagnostics  URL/页面诊断和 candidate 报告
0.3.0-api          单页 API 请求和 json_url 下载
0.4.0-layers       设计 JSON 图层、文字、样式和资源解析
0.5.0-inspector    本地图层检查器和 DesignContext
0.6.0-mcp          MCP 查询真实 confirmed 数据
0.7.0-mvp          版本、资源、扩展模式和可重复交付
```

