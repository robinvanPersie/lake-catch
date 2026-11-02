import type { CapabilityReport, PageDiagnostics, SyncRequest } from "@lake/protocol";

export interface LanhuPageSnapshot {
  url: string;
  title: string;
  diagnostics?: PageDiagnostics;
}

const lanhuHosts = new Set(["lanhuapp.com", "www.lanhuapp.com"]);

export function isLanhuUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (lanhuHosts.has(url.hostname) || url.hostname.endsWith(".lanhuapp.com"));
  } catch {
    return false;
  }
}

export interface LanhuPageIdentity {
  projectId?: string;
  imageId?: string;
  teamId?: string;
  pageId?: string;
  resourceType?: string;
}

export function parseLanhuPageIdentity(value: string): LanhuPageIdentity | null {
  if (!isLanhuUrl(value)) return null;
  const url = new URL(value);
  const route = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const queryStart = route.indexOf("?");
  if (queryStart < 0) return {};
  const params = new URLSearchParams(route.slice(queryStart + 1));
  const identity: LanhuPageIdentity = {
    projectId: params.get("project_id") ?? undefined,
    imageId: params.get("image_id") ?? undefined,
    teamId: params.get("tid") ?? undefined,
    pageId: params.get("pid") ?? undefined,
    resourceType: params.get("type") ?? undefined
  };
  return Object.values(identity).some(Boolean) ? identity : {};
}

export interface LanhuAdapter {
  probe(request: SyncRequest, page: LanhuPageSnapshot): Promise<CapabilityReport>;
}

/**
 * P0 adapter: records what the desktop shell knows without pretending to have
 * parsed Lanhu internals. The real page probe is added after a live-page test.
 */
export class PendingLanhuAdapter implements LanhuAdapter {
  readonly version = "0.5.0-structured-data-probe";

  async probe(request: SyncRequest, page: LanhuPageSnapshot): Promise<CapabilityReport> {
    const pageUrl = page.url || request.pageUrl;
    if (!isLanhuUrl(pageUrl)) {
      return {
        status: "failed",
        pageUrl,
        pageTitle: page.title || "未读取到页面标题",
        checkedAt: new Date().toISOString(),
        adapterVersion: this.version,
        diagnostics: page.diagnostics,
        capabilities: {
          pageIdentity: false,
          previewImage: false,
          nodeTree: false,
          measurements: false,
          assets: false
        },
        notes: [
          "当前地址不是受支持的 Lake 网页地址。",
          "请使用 https://lanhuapp.com 或其子域名下的设计稿链接。",
          "本次探针未读取页面内容，也未保存账号密码、Cookie 或 Token。"
        ]
      };
    }
    const parsedIdentity = parseLanhuPageIdentity(pageUrl);
    const hasPageIdentity = Boolean(parsedIdentity && Object.values(parsedIdentity).some(Boolean));
    const pageIdentity = hasPageIdentity ? parsedIdentity ?? undefined : undefined;
    return {
      status: hasPageIdentity ? "partial" : "failed",
      pageUrl,
      pageTitle: page.title || "未读取到页面标题",
      pageIdentity,
      checkedAt: new Date().toISOString(),
      adapterVersion: this.version,
      diagnostics: page.diagnostics,
      capabilities: {
          pageIdentity: hasPageIdentity,
        previewImage: false,
        nodeTree: false,
        measurements: false,
        assets: false
      },
      notes: [
        "已记录当前页面地址和标题。",
        ...(page.diagnostics ? [
          `页面状态：${page.diagnostics.readyState}，渲染面：${page.diagnostics.renderSurface}，DOM 元素 ${page.diagnostics.domElementCount} 个，节点标识候选 ${page.diagnostics.nodeMarkerCount} 个，语义元素 ${page.diagnostics.semanticElementCount} 个，可编辑元素 ${page.diagnostics.contentEditableCount} 个，正文文本 ${page.diagnostics.bodyTextLength} 字符，图片 ${page.diagnostics.imageCount} 个，Canvas ${page.diagnostics.canvasCount} 个，SVG ${page.diagnostics.svgCount} 个，iframe ${page.diagnostics.iframeCount} 个。`
        ] : []),
        ...(page.diagnostics?.svgSummaries?.length ? [
          `已读取 ${page.diagnostics.svgSummaries.length} 个 SVG 结构摘要（不读取 path 数据），开放 Shadow DOM 数量 ${page.diagnostics.shadowRootCount ?? 0}。`
        ] : []),
        ...(page.diagnostics?.visibleSurfaceSummaries?.length ? [
          `已读取 ${page.diagnostics.visibleSurfaceSummaries.length} 个可见区域摘要；其中含图片 ${page.diagnostics.visibleSurfaceSummaries.filter((surface) => surface.imageDescendantCount > 0).length} 个、Canvas ${page.diagnostics.visibleSurfaceSummaries.filter((surface) => surface.canvasDescendantCount > 0).length} 个、SVG ${page.diagnostics.visibleSurfaceSummaries.filter((surface) => surface.svgDescendantCount > 0).length} 个、CSS 背景图 ${page.diagnostics.visibleSurfaceSummaries.filter((surface) => surface.backgroundImage).length} 个。`
        ] : [
          "当前 DOM 中未发现满足尺寸或媒体条件的可见设计区域摘要。"
        ]),
        ...(page.diagnostics?.imageSummaries?.length ? [
          `已读取 ${page.diagnostics.imageSummaries.length} 个图片尺寸摘要（不保存图片地址或内容）；最大自然尺寸为 ${Math.max(...page.diagnostics.imageSummaries.map((image) => image.naturalWidth * image.naturalHeight))} 像素面积。`,
          ...(page.diagnostics.imageSummaries.some((image) => image.visible && image.width >= 240 && image.height >= 160)
            ? ["已识别至少一个可见的大尺寸图片预览，但尚未保存其图片资源，因此 previewImage 能力仍待资源安全保存方案验证。"]
            : [])
        ] : []),
        ...(page.diagnostics?.annotationSummaries?.length ? [
          `发现 ${page.diagnostics.annotationSummaries.length} 个疑似标注/规格面板结构摘要（仅记录结构、尺寸和文本长度，不保存面板文字）；提取到 ${page.diagnostics.annotationSummaries.reduce((total, item) => total + item.numericValues.length, 0)} 个原始数字，其中 ${page.diagnostics.annotationSummaries.reduce((total, item) => total + item.likelyMeasurements.length, 0)} 个符合初步尺寸候选规则，带 px 单位 ${page.diagnostics.annotationSummaries.reduce((total, item) => total + item.pxValueCount, 0)} 个。候选值仍需结合字段标签验证，不能直接视为最终标注。`
        ] : [
          "当前页面快照未发现疑似标注/规格面板；请先在 Lake 中选中一个设计元素后再次同步。"
        ]),
        ...(page.diagnostics?.platformContext ? [
          `已读取右上角平台选择器：${page.diagnostics.platformContext.label ?? page.diagnostics.platformContext.kind}；目标设计单位按平台暂推为 ${page.diagnostics.platformContext.designUnit}${page.diagnostics.platformContext.scrollable ? `，页面宽度 ${page.diagnostics.platformContext.viewportWidth ?? "未知"}、内容高度 ${page.diagnostics.platformContext.contentHeight ?? "未知"}，按可滚动页面处理` : ""}，仍标记为 candidate，不替代标注面板明确写出的原始单位。`
        ] : [
          "未读取到右上角平台选择器，规格单位不会根据平台自动推断。"
        ]),
        ...(page.diagnostics?.nodeCandidates?.length ? [
          `已读取 ${page.diagnostics.nodeCandidates.length} 个带稳定标识的节点候选，仅包含标识、标签、层级关系和边界框。`
        ] : []),
        ...(page.diagnostics?.nodeCandidates?.some((candidate) => candidate.classification === "page-ui") ? [
          `已识别 ${page.diagnostics.nodeCandidates.filter((candidate) => candidate.classification === "page-ui").length} 个候选属于 Lake 页面 UI（例如图层面板），未写入设计节点树。`
        ] : []),
        ...(page.diagnostics?.structuredDataProbe ? [
          `结构化设计数据探针：${page.diagnostics.structuredDataProbe.status}；发现 ${page.diagnostics.structuredDataProbe.resourceCount} 个同源资源、${page.diagnostics.structuredDataProbe.jsonResourceCount} 个 JSON 候选，成功解析 ${page.diagnostics.structuredDataProbe.parsedResourceCount} 个，提取 ${page.diagnostics.structuredDataProbe.nodeCount} 个图层候选、${page.diagnostics.structuredDataProbe.assetCount} 个资源候选和 ${page.diagnostics.structuredDataProbe.measurementCount} 个尺寸候选。`,
          ...page.diagnostics.structuredDataProbe.notes
        ] : [
          "尚未运行结构化设计数据探针。"
        ]),
        ...(hasPageIdentity
          ? ["已从 Lake detailDetach 路由识别设计稿页面参数。"]
          : ["未从当前 URL 识别到设计稿页面参数。"]),
        ...(page.diagnostics?.nodeCandidates?.length ? [
          "当前节点数据是 DOM 只读探针结果，不等同于 Lake 完整图层树；完整节点类型、样式和资源映射仍待验证。"
        ] : ["Lake 页面结构尚未用真实账号验证，设计节点、标注和资源读取待完成。"]),
        "本次探针不保存账号密码、Cookie 或 Token。"
      ]
    };
  }
}
