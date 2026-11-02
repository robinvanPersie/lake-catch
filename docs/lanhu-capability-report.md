# Lake能力报告

状态：页面诊断已验证；API/设计 JSON 主链路待实现

日期：2026-10-23

## 1. 结论

当前内置 WebView 已经可以：打开并保持用户主动登录的Lake页面；识别Lake HTTPS URL；从真实 `detailDetach` 链接解析 `project_id`、`image_id`、`tid/pid`、`type`；记录标题、来源 URL、加载状态和诊断摘要；识别平台单位候选；识别长图预览及其可滚动内容尺寸。

当前不能确认：DOM 候选是否对应真实设计图层、页面数字是否对应具体节点规格、页面是否加载了可直接读取的设计 JSON，以及完整图层树、样式、资源和评论。

因此，当前同步结果为 `partial` 或 `candidate` 时，只能作为诊断结果，不能作为 Codex 的完整设计上下文。

## 2. DesignBridge 对照后的接入结论

```text
当前登录态 -> Lake项目/页面 API -> json_url -> 设计 JSON
           -> artboard.layers 递归解析 -> 本地图层树、资源、评论
```

这比模拟点击或读取 DOM 更接近Lake实际数据模型，也能让“选中整页后获得所有标注”成为一次完整 JSON 同步，而不是逐个打开标注窗口。

## 3. 已观察到的诊断结果

- 真实页面显示为Lake页面 UI 加一张可滚动长图。
- 数百个带稳定标识的页面元素主要属于Lake界面，不应写入设计节点树。
- 标注/规格面板数字没有稳定的节点语义绑定，只能是 `candidate`。
- 结构化探针曾返回 `partial`，并出现异步请求未完成、resourceCount 为 0、nodeCount 为 0；这不是完整设计数据采集成功。

## 4. 能力状态

| 能力 | 当前状态 | 说明 |
|---|---|---|
| 页面身份识别 | supported | URL 路由参数可解析 |
| 登录态短暂使用 | planned | 接入 WebView Cookie/localStorage token |
| 项目/页面 API | planned | Rust `reqwest` 适配器 |
| `json_url` 下载 | planned | 处理响应变体和限流 |
| 图层树 | unavailable | 等真实 JSON 解析链路 |
| 文字和样式 | unavailable | 不从 DOM 猜测 |
| 资源/切图 | planned | 随 JSON 引用下载 |
| 评论 | planned | 随 JSON 映射 |
| 页面长图预览 | partial | 仅预览/诊断 |
| 数字规格候选 | candidate | 未绑定 confirmed 节点 |

## 5. 安全边界

- 不保存账号密码。
- Cookie/token 仅用于单次请求，日志只记录脱敏状态。
- 不保存完整原始响应，除非用户主动导出脱敏诊断。
- 只同步用户主动触发且有权限访问的页面。

