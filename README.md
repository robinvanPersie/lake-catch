# Lake Catch

Lake Catch 是一个帮助 AI 将蓝湖设计稿转换为具体代码的 macOS 桌面应用。它可以打开并同步蓝湖设计稿，提取页面结构、图层、样式、标注、视觉预览和可用资源，再通过本地 MCP 提供给 Codex 等 AI 工具。

连接 MCP 后，可以直接让 AI 根据当前整张设计稿或选中的局部区域生成目标平台代码，例如 Android Jetpack Compose、Android XML、iOS SwiftUI、UIKit、React 等。Lake Catch 负责提供设计上下文，具体代码由用户连接的 AI 工具在目标项目中生成。

## 普通用户使用

### 1. 安装应用

1. 下载 `Lake-Catch-macos-arm64.zip`。
2. 解压得到 `Lake Catch.app`。
3. 将应用移动到系统的 `Applications` 文件夹。
4. 双击打开应用。

当前发布包面向 Apple Silicon Mac。如果 macOS 首次阻止打开，请到“系统设置 -> 隐私与安全性”中允许打开；也可以在 Finder 中右键应用并选择“打开”。

### 2. 登录和打开设计页面

1. 点击“打开 Lake”。
2. 在应用内完成登录。
3. 打开需要同步的设计页面。
4. 如果在网页内切换了设计稿，先确认地址栏已经切换到目标页面。
5. 点击“同步当前页面”。

同步成功后，设计数据会保存在本机，之后可以通过 MCP 查询。应用会记住最近一次打开的页面；如果页面地址没有变化，先重新打开目标设计稿再同步。

### 3. 整页和局部区域

- 不选择局部区域直接同步时，MCP 默认提供整张设计稿。
- 在设计预览中点击某个节点或区域后，可以创建局部 `context`，再使用“交给 AI”将该区域交给 AI 工具。
- 同步完成后不会自动代表用户创建局部 context；需要明确选中区域并创建或交付。
- 设计预览可以拖动画布，并使用滚轮或触控板进行缩放；长页面需要在画布中继续向下查看。

### 4. “交给 AI”按钮

“交给 AI”用于把当前选中的局部设计节点交给 Codex 等 AI 工具：

1. 在设计预览或图层树中选中一个真实设计图层。
2. 点击该节点旁边的“交给 AI”。
3. Lake Catch 会创建一个只包含该节点及其子节点的局部 `context`。
4. 应用会把设计稿名称、节点名称和 `contextId` 复制到剪贴板。
5. 将复制的内容发送给 AI 工具，AI 工具再通过 MCP 读取该局部 context。

这个按钮只影响本次局部交付，不会删除或修改整张设计稿。没有选中图层、选中的是诊断候选而不是真实设计图层，或者当前数据不是 `lake-json` 图层时，按钮不会显示或不可交付。

如果不点击“交给 AI”，而是直接让 AI 工具读取当前设计稿，默认使用整张设计稿的实现上下文。

### 5. “专注预览”按钮

“专注预览”用于临时扩大设计画布的可用空间，适合查看长页面或检查细节：

- 收起顶部工具区域。
- 隐藏右侧报告和检查区域。
- 保留左侧图层导航和中间设计预览。
- 不会改变同步数据、当前选中节点、MCP 配置或局部 context。
- 点击“退出专注”或按 `Esc` 恢复普通布局。

专注模式只是界面布局切换，不是另一种同步模式；进入或退出专注模式不会重新同步设计稿。

## 接入 Codex 和其他 AI 工具

### 推荐方式：应用内导入

1. 先将 `Lake Catch.app` 放入系统 `Applications` 文件夹。
2. 打开 Lake Catch。
3. 在“AI 工具连接”区域点击“添加到 Codex”或“导入 MCP”。
4. 重启 Codex，使 MCP 配置重新加载。
5. 回到 Lake Catch 同步设计稿。
6. 在 Codex 中直接要求它读取当前设计稿，不需要手动填写 `documentId` 或 `contextId`。

如果应用内导入按钮不可用，可以使用“复制通用配置”，将配置粘贴到支持 MCP 的客户端中。配置中的启动命令会自动查找放在 `Applications`、`~/Applications`、`Downloads` 或桌面的 Lake Catch 应用。

### 推荐的调用入口

连接成功后，AI 工具优先读取当前设计稿：

```json
{
  "name": "get_current_implementation_context",
  "arguments": {}
}
```

如果用户在 Lake Catch 中创建了局部 context，再读取对应的 `contextId`。不创建局部 context 时，AI 工具默认读取整张设计稿。

MCP 只提供设计输入，不限制生成的技术栈。可以在请求中说明目标平台，例如 Android Jetpack Compose、Android XML、iOS SwiftUI、UIKit、React 或其他实现方式。

## 常见问题

### MCP 显示无法连接或获取不到数据

按以下顺序检查：

1. 确认 `Lake Catch.app` 已放入系统 `Applications` 文件夹。
2. 确认打开的是当前版本，而不是旧的开发包或重复的应用副本。
3. 完全退出并重新打开 Codex，让 MCP 配置重新加载。
4. 打开 Lake Catch 并先同步至少一张设计稿。
5. 在 AI 工具中重新读取当前 context。

如果 macOS 上存在多个 Lake Catch 副本，MCP 可能启动了旧版本。建议只保留一个应用副本，并在“应用程序”中确认应用名称为 `Lake Catch.app`。

### “复制通用配置”显示成功，但粘贴为空

这通常是系统剪贴板权限或客户端剪贴板读取问题。可以尝试：

1. 再点击一次复制按钮。
2. 在普通文本编辑器中粘贴，确认剪贴板是否真的有内容。
3. 使用应用内“添加到 Codex”或“导入 MCP”，避免手动复制。
4. 确认 Lake Catch 没有被系统限制剪贴板访问。

### 导入 MCP 后仍提示路径不存在

请把 `Lake Catch.app` 放到以下任一位置，优先使用系统应用程序目录：

```text
/Applications/Lake Catch.app
~/Applications/Lake Catch.app
```

移动应用后，需要重新启动 Codex。MCP 启动配置会自动搜索应用，不应该依赖开发机上的项目路径。

### 打开页面后白屏

1. 确认当前登录状态仍然有效。
2. 点击回到 Lake 首页，确认页面可以正常加载。
3. 在应用内重新打开设计页面。
4. 如果刚切换过账号或团队，先刷新页面再同步。
5. 重新启动 Lake Catch 后再次打开设计页面。

如果只有某一张设计稿白屏，先确认原始设计页面在普通浏览器中可以打开；如果原页面也打不开，通常是登录权限、团队权限或页面地址问题。

### 同步的设计预览不是当前设计稿

确认以下事项：

- 当前地址栏已经切换到目标设计稿。
- 切换设计稿后等待页面完成加载。
- 点击“同步当前页面”时，当前窗口显示的确实是目标页面。
- MCP 读取的是最新的当前 context，而不是旧的 `contextId`。

如果仍然不一致，可以重新同步目标页面，并在 AI 工具中先调用 `list_design_documents` 查看当前保存的文档列表。

### 设计预览和原稿有差异

MCP 同时提供结构化节点和官方视觉预览。结构化数据适合生成代码，视觉预览适合核对整体布局。以下内容可能出现差异：

- 原页面中的动态内容、动画或交互状态。
- 没有公开资源 URL 的图片或图标。
- 设计稿中只存在于视觉渲染、但没有结构化节点的数据。
- Sketch 导出的特殊字段或未被当前适配器识别的样式。

AI 工具实现页面时，应同时读取结构化 context 和视觉预览，不要把整页预览图直接当成页面代码。

### 切图下载没有反应

先确认已经同步当前设计稿，并且当前节点确实存在可下载的切图资源。部分节点只有结构信息，没有可用的原始资源 URL，因此不会生成下载文件。可以先通过 MCP 的资源查询确认该节点是否有 `sourceUrl`、`localPath` 或可下载状态。

## 开发者本地运行

需要 Node.js、pnpm 和 Rust/Tauri 工具链：

```bash
pnpm install
pnpm check
pnpm --filter @lake/desktop tauri dev
```

本地构建：

```bash
pnpm --filter @lake/desktop tauri build
```

本地生成 Apple Silicon `.app`：

```bash
pnpm build:desktop:arm64:app
```

产物位于：

```text
apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Lake Catch.app
```

## GitHub 自动构建

`.github/workflows/build-macos-app.yml` 支持两种方式：

- 在 GitHub 的 **Actions -> Build macOS app -> Run workflow** 手动构建。
- 推送 `v*` 格式的标签，例如 `v0.2.0`，自动创建 GitHub Release。

构建结果为：

```text
Lake-Catch-macos-arm64.zip
```

当前 workflow 使用 adhoc 签名，不使用 Apple Developer 证书。正式公开分发时，需要额外配置 Developer ID 签名和 notarization。

