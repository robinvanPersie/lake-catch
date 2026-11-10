import { useEffect, useMemo, useRef, useState } from "react";
import { isLanhuUrl, PendingLanhuAdapter } from "@lake/adapter";
import type { PageDiagnostics, PageStructuredDataProbe, SyncRecord } from "@lake/protocol";
import {
  createEmptyDesignDocument,
  type DesignDocument,
  type DesignDocumentRevisionSnapshot,
  type DesignAsset,
  type DesignContext,
  type DesignMeasurementCandidate,
  type DesignNode
} from "@lake/design-model";
import { invoke } from "@tauri-apps/api/core";
import DesignPreview from "./DesignPreview";
import LayerInspector from "./LayerInspector";

const lakeHomeUrl = "https://lanhuapp.com/web/";
const lastOpenedUrlKey = "lake-bridge.last-opened-url.v1";
const historyKey = "lanhu-bridge.sync-history.v1";
const documentsKey = "lanhu-bridge.design-documents.v1";
const adapter = new PendingLanhuAdapter();

interface AppState {
  history: SyncRecord[];
  documents: DesignDocument[];
  contexts: DesignContext[];
  currentDocumentId?: string | null;
  currentNodeId?: string | null;
}

type RawSnapshotSvg = {
  id: string | null;
  class_name: string | null;
  width: number;
  height: number;
  view_box: string | null;
  element_count: number;
  visible: boolean;
};

type RawSnapshotSurface = {
  tag_name: string;
  id: string | null;
  class_name: string | null;
  role: string | null;
  width: number;
  height: number;
  child_element_count: number;
  image_descendant_count: number;
  canvas_descendant_count: number;
  svg_descendant_count: number;
  background_image: boolean;
};

type RawSnapshotImage = {
  id: string | null;
  class_name: string | null;
  width: number;
  height: number;
  natural_width: number;
  natural_height: number;
  visible: boolean;
};

type RawSnapshotAnnotation = {
  tag_name: string;
  id: string | null;
  class_name: string | null;
  role: string | null;
  width: number;
  height: number;
  text_length: number;
  numeric_values: number[];
  measurements?: { value: number; unit: "px" | "percent" | "rem" | "em" | "rpx" | "number" }[];
  likely_measurements: number[];
  px_value_count: number;
  child_element_count: number;
  visible: boolean;
};

type RawSnapshotPlatformContext = {
  label: string | null;
  kind: "ios" | "android" | "web" | "unknown";
  design_unit: "pt" | "dp" | "px" | "unknown";
  viewport_width: number | null;
  content_height: number | null;
  scrollable: boolean;
  confidence: "candidate" | "confirmed";
  source: "lanhu-platform-selector";
};

type RawSnapshotCandidate = {
  marker: string;
  marker_type: "data-node-id" | "data-id" | "data-layer-id" | "data-element-id";
  tag_name: string;
  class_name: string | null;
  role: string | null;
  svg_ancestor: boolean;
  ancestor_depth: number;
  classification: "page-ui" | "design-candidate" | "unknown";
  name: string | null;
  parent_marker: string | null;
  bounds?: { x: number; y: number; width: number; height: number };
  visible: boolean;
};

type RawStructuredProbe = {
  status: "not-run" | "candidate" | "partial" | "ready" | "failed";
  resource_count: number;
  json_resource_count: number;
  parsed_resource_count: number;
  node_count: number;
  asset_count: number;
  measurement_count: number;
  resources: {
    path: string;
    status: number;
    content_type?: string;
    parsed: boolean;
    top_level_keys: string[];
  }[];
  nodes: {
    source_path: string;
    node_type?: string;
    name?: string;
    text?: string;
    bounds?: { x: number; y: number; width: number; height: number };
    style_keys: string[];
    confidence: "candidate" | "confirmed";
  }[];
  assets: {
    source_path: string;
    name?: string;
    kind: "image" | "icon" | "font" | "unknown";
    width?: number;
    height?: number;
    confidence: "candidate" | "confirmed";
  }[];
  notes: string[];
};

type LakeApiSyncResult = {
  status: "ready" | "failed";
  stage: string;
  endpoint?: string;
  http_status?: number;
  project_id?: string;
  image_id?: string;
  team_id?: string;
  json_url?: string;
  json_size?: number;
  raw_json_path?: string;
  preview_url?: string;
  preview_path?: string;
  root_keys: string[];
  layers: {
    id: string;
    parent_id?: string;
    name: string;
    layer_type: string;
    bounds?: { x: number; y: number; width: number; height: number };
    text?: string;
    visible: boolean;
    depth: number;
    style?: Record<string, import("@lake/design-model").DesignStyleValue>;
    asset_url?: string;
  }[];
  assets: {
    id: string;
    name: string;
    kind: string;
    source_url?: string;
    width?: number;
    height?: number;
    density?: string;
    download_policy: "skip-density-variant" | "download-candidate" | "review";
    local_path?: string;
    download_status: "pending" | "downloaded" | "cached" | "skipped" | "review" | "failed";
    checksum?: string;
    byte_size?: number;
    mime_type?: string;
    reference_count?: number;
  }[];
  notes: string[];
};

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Fall back to the native command when the WebView clipboard is denied.
  }
  await invoke("copy_text_to_clipboard", { text: value });
}

function portableMcpConfig() {
  // The generic config is intentionally short and machine-independent. The
  // app is distributed as a normal macOS application in /Applications.
  const appResource = "/Applications/Lake Catch.app/Contents/Resources/mcp-server";
  return {
    mcpServers: {
      lake: {
        command: `${appResource}/node`,
        args: [`${appResource}/index.mjs`]
      }
    }
  };
}

function loadLegacyState(): AppState {
  try {
    const historyValue = localStorage.getItem(historyKey);
    const documentsValue = localStorage.getItem(documentsKey);
    const history = historyValue ? JSON.parse(historyValue) : [];
    const documents = documentsValue ? JSON.parse(documentsValue) : [];
    return {
      history: Array.isArray(history) ? history as SyncRecord[] : [],
      documents: Array.isArray(documents) ? documents as DesignDocument[] : [],
      contexts: []
    };
  } catch {
    return { history: [], documents: [], contexts: [] };
  }
}

async function saveAppState(state: AppState) {
  await invoke("save_app_state", { state: JSON.stringify(state) });
}

type AssetCleanupResult = {
  stale_cache_entries: number;
  orphan_files: number;
  removed_files: number;
  notes: string[];
};

type DiagnosticLogEntry = {
  at: string;
  level: "info" | "error";
  event: string;
  detail?: string;
};

function documentIdFor(record: SyncRecord) {
  const identity = record.report.pageIdentity;
  const parts = [identity?.projectId, identity?.imageId, identity?.pageId].filter(Boolean);
  return parts.length > 0 ? `lanhu:${parts.join(":")}` : `lanhu:request:${record.request.requestId}`;
}

function reportMarkdown(record: SyncRecord) {
  const capabilityLines = Object.entries(record.report.capabilities)
    .map(([key, enabled]) => `- ${key}: ${enabled ? "已具备" : "待验证"}`)
    .join("\n");
  const notes = record.report.notes.map((note) => `- ${note}`).join("\n");
  const diagnostics = record.report.diagnostics
    ? `\n## 页面诊断\n\n- 加载状态：${record.report.diagnostics.readyState}\n- 渲染面：${record.report.diagnostics.renderSurface}\n- DOM 元素数量：${record.report.diagnostics.domElementCount}\n- 节点标识候选：${record.report.diagnostics.nodeMarkerCount}\n- 语义元素数量：${record.report.diagnostics.semanticElementCount}\n- 可编辑元素数量：${record.report.diagnostics.contentEditableCount}\n- 正文字符数：${record.report.diagnostics.bodyTextLength}\n- 图片数量：${record.report.diagnostics.imageCount}\n- Canvas 数量：${record.report.diagnostics.canvasCount}\n- SVG 数量：${record.report.diagnostics.svgCount}\n- iframe 数量：${record.report.diagnostics.iframeCount}\n`
    : "";
  const platform = record.report.diagnostics?.platformContext;
  const platformLine = platform ? `- 当前平台：${platform.label ?? platform.kind}（目标单位候选：${platform.designUnit}）\n` : "";
  return `# Lake 能力报告\n\n- 页面标题：${record.report.pageTitle}\n- 页面地址：${record.report.pageUrl}\n- 同步时间：${record.report.checkedAt}\n- 适配器版本：${record.report.adapterVersion}\n- 状态：${record.report.status}\n${platformLine}${diagnostics}\n## 能力\n${capabilityLines}\n\n## 说明\n${notes}\n`;
}

function diagnosticUrl(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const queryKeys = Array.from(url.searchParams.keys());
    const fragment = url.hash ? "#<redacted>" : "";
    return `${url.origin}${url.pathname}${queryKeys.length > 0 ? `?${queryKeys.map((key) => `${encodeURIComponent(key)}=<redacted>`).join("&")}` : ""}${fragment}`;
  } catch {
    return "<invalid-url>";
  }
}

function diagnosticText(value: string) {
  return value
    .replace(/(cookie|token|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/https?:\/\/[^\s)]+/gi, "<url-redacted>")
    .slice(0, 500);
}

function loadLastOpenedUrl() {
  try {
    const savedUrl = localStorage.getItem(lastOpenedUrlKey)?.trim();
    return savedUrl && isLanhuUrl(savedUrl) ? savedUrl : lakeHomeUrl;
  } catch {
    return lakeHomeUrl;
  }
}

export default function App() {
  const [pageUrl, setPageUrl] = useState(loadLastOpenedUrl);
  const [openedUrl, setOpenedUrl] = useState(loadLastOpenedUrl);
  const [status, setStatus] = useState("等待操作");
  const [browserOpened, setBrowserOpened] = useState(false);
  const [lastBrowserUrlSyncAt, setLastBrowserUrlSyncAt] = useState<string | null>(null);
  const [result, setResult] = useState<SyncRecord | null>(null);
  const [history, setHistory] = useState<SyncRecord[]>([]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DesignDocument[]>([]);
  const [contexts, setContexts] = useState<DesignContext[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [activeView, setActiveView] = useState<"browser" | "preview">("browser");
  const [apiSyncResult, setApiSyncResult] = useState<LakeApiSyncResult | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [activeRevisionVersion, setActiveRevisionVersion] = useState<number | null>(null);
  const [diagnosticLog, setDiagnosticLog] = useState<DiagnosticLogEntry[]>([]);
  const [isConfiguringMcp, setIsConfiguringMcp] = useState(false);
  const [isPreviewFocused, setIsPreviewFocused] = useState(false);
  const [isLayerInspectorCollapsed, setIsLayerInspectorCollapsed] = useState(false);

  useEffect(() => {
    if (!status) return;
    const entry: DiagnosticLogEntry = {
      at: new Date().toISOString(),
      level: status.includes("失败") ? "error" : "info",
      event: "ui-status",
      detail: diagnosticText(status)
    };
    setDiagnosticLog((current) => [...current, entry].slice(-100));
  }, [status]);

  useEffect(() => {
    if (!isPreviewFocused) return;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsPreviewFocused(false);
    };
    window.addEventListener("keydown", exitOnEscape);
    return () => window.removeEventListener("keydown", exitOnEscape);
  }, [isPreviewFocused]);

  useEffect(() => {
    if (activeView !== "preview" || !result) setIsPreviewFocused(false);
  }, [activeView, result]);

  useEffect(() => {
    if (!browserOpened) return;

    let cancelled = false;
    const syncBrowserUrl = async () => {
      try {
        const currentUrl = (await invoke<string | null>("get_lanhu_browser_url"))?.trim();
        if (cancelled) return;
        if (!currentUrl) {
          setBrowserOpened(false);
          return;
        }

        // Keep both URL controls and the durable last-opened value aligned
        // even when the route changed before the polling callback observed it.
        if (isLanhuUrl(currentUrl)) setPageUrl(currentUrl);
        try {
          localStorage.setItem(lastOpenedUrlKey, currentUrl);
        } catch {
          // The current URL remains usable even if browser storage is denied.
        }
        if (currentUrl === openedUrl) return;

        // The design window is navigable independently from the Catch
        // window. Mirror its current route so a design switch becomes the
        // next sync target and the last-opened page remains accurate.
        setOpenedUrl(currentUrl);
        const detectedAt = new Date().toISOString();
        setLastBrowserUrlSyncAt(detectedAt);
        setStatus(`已检测到设计稿切换：${formatTime(detectedAt)}`);
      } catch {
        // The browser window may be between navigation and destruction.
      }
    };

    void syncBrowserUrl();
    const timer = window.setInterval(() => { void syncBrowserUrl(); }, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [browserOpened, openedUrl]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let state: AppState | null = null;
      try {
        const raw = await invoke<string | null>("load_app_state");
        if (raw) state = JSON.parse(raw) as AppState;
      } catch {
        // Fall back to the pre-migration browser storage below.
      }
      state ??= loadLegacyState();
      if (cancelled) return;
      const records = Array.isArray(state.history) ? state.history : [];
      const storedDocuments = Array.isArray(state.documents) ? state.documents : [];
      const storedContexts = Array.isArray(state.contexts) ? state.contexts : [];
      const restoredDocumentId = typeof state.currentDocumentId === "string" && storedDocuments.some((item) => item.id === state?.currentDocumentId)
        ? state.currentDocumentId
        : records[0] ? documentIdFor(records[0]) : storedDocuments[0]?.id ?? null;
      const restoredDocument = restoredDocumentId ? storedDocuments.find((item) => item.id === restoredDocumentId) : undefined;
      const restoredNodeId = restoredDocument && typeof state.currentNodeId === "string" && restoredDocument.nodes[state.currentNodeId]
        ? state.currentNodeId
        : null;
      setHistory(records);
      setResult(records[0] ?? null);
      setDocuments(storedDocuments);
      setContexts(storedContexts);
      setDocumentId(restoredDocumentId);
      setSelectedNodeId(restoredNodeId ?? undefined);
      if (records[0]) setStatus("已恢复上次同步结果");
      try {
        await saveAppState({ history: records, documents: storedDocuments, contexts: storedContexts, currentDocumentId: restoredDocumentId, currentNodeId: restoredNodeId });
      } catch {
        // The UI remains usable if the app data directory is temporarily unavailable.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // A node id is only meaningful inside the document that owns it. Clear stale
  // selections when switching documents, restoring old state, or deleting data.
  useEffect(() => {
    const currentDocument = documentId ? documents.find((item) => item.id === documentId) : undefined;
    if (!currentDocument) {
      if (selectedNodeId) setSelectedNodeId(undefined);
      return;
    }
    const currentSnapshot = activeRevisionVersion
      ? currentDocument.revisionSnapshots?.find((snapshot) => snapshot.version === activeRevisionVersion)
      : undefined;
    const nodes = currentSnapshot?.nodes ?? currentDocument.nodes;
    if (selectedNodeId && nodes[selectedNodeId]) return;
    if (selectedNodeId) setSelectedNodeId(undefined);
  }, [activeRevisionVersion, documentId, documents, selectedNodeId]);

  const report = result?.report;
  const capabilityRows = useMemo(() => {
    if (!report) return [];
    return Object.entries(report.capabilities).map(([key, enabled]) => ({ key, enabled }));
  }, [report]);

  async function syncCurrentPage() {
    if (isSyncing) return;
    setIsSyncing(true);
    // Do not leave the previous document visible while a different design is
    // being resolved. The new document is selected only after its JSON and
    // local node model have been written successfully.
    setResult(null);
    setDocumentId(null);
    setApiSyncResult(null);
    setActiveView("browser");
    setSelectedNodeId(undefined);
    setActiveRevisionVersion(null);
    let currentUrl = openedUrl.trim();
    let currentTitle = "Lake 设计稿（待真实页面验证）";
    let structuredDataProbe: PageStructuredDataProbe | undefined;
    let apiSyncResult: LakeApiSyncResult | undefined;
    let pageSnapshot: {
      url: string;
      title: string;
      diagnostics?: PageDiagnostics;
    } = { url: currentUrl, title: currentTitle };
    setStatus("正在读取当前 Lake 页面…");
    try {
      const snapshot = await invoke<{
        url: string;
        title: string;
        ready_state: "loading" | "interactive" | "complete" | string;
        dom_element_count: number;
        node_marker_count: number;
        semantic_element_count: number;
        content_editable_count: number;
        body_text_length: number;
        image_count: number;
        canvas_count: number;
        svg_count: number;
        iframe_count: number;
        shadow_root_count: number;
        svg_summaries: RawSnapshotSvg[];
        visible_surface_summaries: RawSnapshotSurface[];
        image_summaries: RawSnapshotImage[];
        annotation_summaries: RawSnapshotAnnotation[];
        platform_context: RawSnapshotPlatformContext | null;
        node_candidates: RawSnapshotCandidate[];
        node_candidate_limit_reached: boolean;
      } | null>("get_lanhu_browser_snapshot");
      currentUrl = snapshot?.url?.trim() || currentUrl;
      currentTitle = snapshot?.title?.trim() || currentTitle;
      if (snapshot) {
        const renderSurface: PageDiagnostics["renderSurface"] = snapshot.canvas_count > 0 && snapshot.dom_element_count > 20
          ? "mixed"
          : snapshot.canvas_count > 0
            ? "canvas"
            : snapshot.svg_count > 0
              ? "svg"
              : snapshot.dom_element_count > 0
                ? "dom"
                : "unknown";
        pageSnapshot = {
        url: currentUrl,
        title: currentTitle,
        diagnostics: {
          readyState: snapshot.ready_state === "loading" || snapshot.ready_state === "interactive" || snapshot.ready_state === "complete"
            ? snapshot.ready_state
            : "unknown",
          renderSurface,
          domElementCount: snapshot.dom_element_count,
          nodeMarkerCount: snapshot.node_marker_count,
          semanticElementCount: snapshot.semantic_element_count,
          contentEditableCount: snapshot.content_editable_count,
          bodyTextLength: snapshot.body_text_length,
          imageCount: snapshot.image_count,
          canvasCount: snapshot.canvas_count,
          svgCount: snapshot.svg_count,
          iframeCount: snapshot.iframe_count,
          shadowRootCount: snapshot.shadow_root_count,
          svgSummaries: (snapshot.svg_summaries ?? []).map((svg) => ({
            id: svg.id ?? undefined,
            className: svg.class_name ?? undefined,
            width: svg.width,
            height: svg.height,
            viewBox: svg.view_box ?? undefined,
            elementCount: svg.element_count,
            visible: svg.visible
          })),
          visibleSurfaceSummaries: (snapshot.visible_surface_summaries ?? []).map((surface) => ({
            tagName: surface.tag_name,
            id: surface.id ?? undefined,
            className: surface.class_name ?? undefined,
            role: surface.role ?? undefined,
            width: surface.width,
            height: surface.height,
            childElementCount: surface.child_element_count,
            imageDescendantCount: surface.image_descendant_count,
            canvasDescendantCount: surface.canvas_descendant_count,
            svgDescendantCount: surface.svg_descendant_count,
            backgroundImage: surface.background_image
          })),
          imageSummaries: (snapshot.image_summaries ?? []).map((image) => ({
            id: image.id ?? undefined,
            className: image.class_name ?? undefined,
            width: image.width,
            height: image.height,
            naturalWidth: image.natural_width,
            naturalHeight: image.natural_height,
            visible: image.visible
          })),
          annotationSummaries: (snapshot.annotation_summaries ?? []).map((annotation) => ({
            tagName: annotation.tag_name,
            id: annotation.id ?? undefined,
            className: annotation.class_name ?? undefined,
            role: annotation.role ?? undefined,
            width: annotation.width,
            height: annotation.height,
            textLength: annotation.text_length,
            numericValues: annotation.numeric_values ?? [],
            measurements: annotation.measurements ?? [],
            likelyMeasurements: annotation.likely_measurements ?? [],
            pxValueCount: annotation.px_value_count ?? 0,
            childElementCount: annotation.child_element_count,
            visible: annotation.visible
          })),
          platformContext: snapshot.platform_context ? {
            label: snapshot.platform_context.label ?? undefined,
            kind: snapshot.platform_context.kind,
            designUnit: snapshot.platform_context.design_unit,
            viewportWidth: snapshot.platform_context.viewport_width ?? undefined,
            contentHeight: snapshot.platform_context.content_height ?? undefined,
            scrollable: snapshot.platform_context.scrollable,
            confidence: snapshot.platform_context.confidence,
            source: snapshot.platform_context.source
          } : undefined,
          structuredDataProbe: undefined,
          nodeCandidates: (snapshot.node_candidates ?? []).map((candidate) => ({
            marker: candidate.marker,
            markerType: candidate.marker_type,
            tagName: candidate.tag_name,
            className: candidate.class_name ?? undefined,
            role: candidate.role ?? undefined,
            svgAncestor: candidate.svg_ancestor,
            ancestorDepth: candidate.ancestor_depth,
            classification: candidate.classification,
            name: candidate.name ?? undefined,
            parentMarker: candidate.parent_marker ?? undefined,
            bounds: candidate.bounds ?? undefined,
            visible: candidate.visible
          })),
          nodeCandidateLimitReached: snapshot.node_candidate_limit_reached
        }
        };
      }
    } catch {
      setStatus("页面快照读取未完成，正在使用当前 URL 继续…");
      try {
        currentUrl = (await invoke<string | null>("get_lanhu_browser_url"))?.trim() || currentUrl;
      } catch {
        // Keep the last known URL when the native browser window is unavailable.
      }
    }

    setStatus("正在查找 Lake 结构化设计数据…");
    try {
      const probe = await invoke<RawStructuredProbe | null>("get_lanhu_structured_data_probe");
      if (probe) {
        structuredDataProbe = {
          status: probe.status,
          resourceCount: probe.resource_count,
          jsonResourceCount: probe.json_resource_count,
          parsedResourceCount: probe.parsed_resource_count,
          nodeCount: probe.node_count,
          assetCount: probe.asset_count,
          measurementCount: probe.measurement_count,
          resources: probe.resources.map((resource) => ({
            path: resource.path,
            status: resource.status,
            contentType: resource.content_type,
            parsed: resource.parsed,
            topLevelKeys: resource.top_level_keys
          })),
          nodes: probe.nodes.map((node) => ({
            sourcePath: node.source_path,
            type: node.node_type,
            name: node.name,
            text: node.text,
            bounds: node.bounds,
            styleKeys: node.style_keys,
            confidence: node.confidence
          })),
          assets: probe.assets.map((asset) => ({
            sourcePath: asset.source_path,
            name: asset.name,
            kind: asset.kind,
            width: asset.width,
            height: asset.height,
            confidence: asset.confidence
          })),
          notes: probe.notes
        };
        pageSnapshot.diagnostics = {
          ...(pageSnapshot.diagnostics ?? {
            readyState: "unknown",
            renderSurface: "unknown",
            domElementCount: 0,
            nodeMarkerCount: 0,
            semanticElementCount: 0,
            contentEditableCount: 0,
            bodyTextLength: 0,
            imageCount: 0,
            canvasCount: 0,
            svgCount: 0,
            iframeCount: 0
          }),
          structuredDataProbe
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      structuredDataProbe = {
        status: "failed",
        resourceCount: 0,
        jsonResourceCount: 0,
        parsedResourceCount: 0,
        nodeCount: 0,
        assetCount: 0,
        measurementCount: 0,
        resources: [],
        nodes: [],
        assets: [],
        notes: [`结构化探针失败：${message}`]
      };
      pageSnapshot.diagnostics = {
        ...(pageSnapshot.diagnostics ?? {
          readyState: "unknown",
          renderSurface: "unknown",
          domElementCount: 0,
          nodeMarkerCount: 0,
          semanticElementCount: 0,
          contentEditableCount: 0,
          bodyTextLength: 0,
          imageCount: 0,
          canvasCount: 0,
          svgCount: 0,
          iframeCount: 0
        }),
        structuredDataProbe
      };
      setStatus(`结构化探针失败，已保留页面快照：${message}`);
    }

    if (!currentUrl) {
      setStatus("同步失败：请先输入 Lake 页面地址");
      setIsSyncing(false);
      return;
    }

    setOpenedUrl(currentUrl);
    setPageUrl(currentUrl);
    setStatus("正在读取当前 Lake 登录态…");
    try {
      const session = await invoke<{ cookies?: string; token?: string }>("get_lake_session");
      setStatus("正在请求 Lake 设计数据 API…");
      apiSyncResult = await invoke<LakeApiSyncResult>("fetch_lake_design_data", {
        pageUrl: currentUrl,
        session
      });
      setApiSyncResult(apiSyncResult);
      setStatus(`API 响应成功，设计 JSON ${apiSyncResult.json_size ?? 0} bytes，资源筛选与下载已完成`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      apiSyncResult = {
        status: "failed",
        stage: "failed",
        root_keys: [],
        layers: [],
        assets: [],
        notes: [message]
      };
      setApiSyncResult(apiSyncResult);
      setStatus(`设计 API 暂未完成：${message}`);
    }
    const requestedAt = new Date().toISOString();
    const request = {
      requestId: crypto.randomUUID(),
      source: "lanhu" as const,
      pageUrl: currentUrl,
      requestedAt
    };
    setStatus("正在生成能力报告…");
    try {
      // Lake 选中图层后会异步渲染标注面板，给 WebView 一个短暂稳定窗口。
      await new Promise((resolve) => setTimeout(resolve, 350));
      const report = await adapter.probe(request, pageSnapshot);
      if (apiSyncResult?.status === "ready" && (apiSyncResult.project_id || apiSyncResult.image_id)) {
        report.pageIdentity = {
          ...(report.pageIdentity ?? {}),
          projectId: apiSyncResult.project_id ?? report.pageIdentity?.projectId,
          imageId: apiSyncResult.image_id ?? report.pageIdentity?.imageId,
          teamId: apiSyncResult.team_id ?? report.pageIdentity?.teamId
        };
      }
      if (apiSyncResult?.status === "ready") {
        report.notes.push(`设计 API 已完成：${apiSyncResult.stage}，JSON 大小 ${apiSyncResult.json_size ?? 0} bytes，提取 ${apiSyncResult.layers.length} 个图层，顶层字段 ${apiSyncResult.root_keys.join(", ") || "无"}。`);
        report.notes.push(...apiSyncResult.notes);
        report.capabilities.pageIdentity = Boolean(apiSyncResult.project_id && apiSyncResult.image_id);
      } else if (apiSyncResult) {
        report.notes.push(`设计 API 阶段 ${apiSyncResult.stage} 未完成：${apiSyncResult.notes.join("；")}`);
      }
      const record: SyncRecord = { request, report, savedAt: new Date().toISOString() };
      const nodeCandidates = report.diagnostics?.nodeCandidates ?? [];
      const nodes: Record<string, DesignNode> = {};
      for (const layer of apiSyncResult?.layers ?? []) {
        const id = `lake-layer:${layer.id}`;
        nodes[id] = {
          id,
          name: layer.name,
          type: layer.layer_type,
          parentId: layer.parent_id ? `lake-layer:${layer.parent_id}` : undefined,
          children: [],
          bounds: layer.bounds,
          visible: layer.visible,
          text: layer.text,
          assetUrl: layer.asset_url,
          style: layer.style,
          sourceRef: `lake-json:${layer.id}`,
          metadata: { svgAncestor: false, ancestorDepth: layer.depth }
        };
      }
      for (const candidate of nodeCandidates) {
        if (candidate.classification === "page-ui") continue;
        const id = `lanhu-node:${candidate.marker}`;
        nodes[id] = {
          id,
          name: candidate.name || `${candidate.tagName} ${candidate.marker}`,
          type: candidate.tagName,
          parentId: candidate.parentMarker ? `lanhu-node:${candidate.parentMarker}` : undefined,
          children: [],
          bounds: candidate.bounds,
          visible: candidate.visible,
          sourceRef: `${candidate.markerType}=${candidate.marker}`,
          metadata: {
            className: candidate.className,
            role: candidate.role,
            svgAncestor: candidate.svgAncestor,
            ancestorDepth: candidate.ancestorDepth
          }
        };
      }
      const structuredNodes = report.diagnostics?.structuredDataProbe?.nodes ?? [];
      for (const [index, candidate] of structuredNodes.entries()) {
        const id = `lanhu-structured-node:${index}:${candidate.sourcePath}`;
        nodes[id] = {
          id,
          name: candidate.name || candidate.type || `结构化候选 ${index + 1}`,
          type: candidate.type || "unknown",
          children: [],
          bounds: candidate.bounds,
          visible: true,
          text: candidate.text,
          sourceRef: `structured:${candidate.sourcePath}`,
          metadata: {
            className: candidate.styleKeys?.join(","),
            role: undefined,
            svgAncestor: false,
            ancestorDepth: 0
          }
        };
      }
      for (const node of Object.values(nodes)) {
        if (node.parentId && nodes[node.parentId]) nodes[node.parentId].children.push(node.id);
      }
      const rootNodeIds = Object.values(nodes).filter((node) => !node.parentId || !nodes[node.parentId]).map((node) => node.id);
      const document = createEmptyDesignDocument({
        id: documentIdFor(record),
        sourceUrl: report.pageUrl,
        title: report.pageTitle,
        syncedAt: record.savedAt,
        adapterVersion: report.adapterVersion,
        capabilityReport: report
      });
      const previousDocument = documents.find((item) => item.id === document.id);
      document.syncVersion = (previousDocument?.syncVersion ?? 0) + 1;
      document.previewUrl = apiSyncResult?.preview_url;
      document.previewPath = apiSyncResult?.preview_path;
      document.nodes = nodes;
      document.rootNodeIds = rootNodeIds;
      for (const asset of apiSyncResult?.assets ?? []) {
        const id = asset.id;
        document.assets[id] = {
          id,
          name: asset.name,
          kind: asset.kind === "icon" ? "icon" : asset.kind === "font" ? "font" : asset.kind === "image" ? "image" : "unknown",
          sourceUrl: asset.source_url,
          width: asset.width,
          height: asset.height,
          density: asset.density,
          downloadPolicy: asset.download_policy,
          localPath: asset.local_path,
          mimeType: asset.mime_type ?? (asset.kind === "image" || asset.kind === "icon" ? "image/*" : undefined),
          downloadStatus: asset.download_status,
          checksum: asset.checksum,
          byteSize: asset.byte_size,
          referenceCount: asset.reference_count
        } satisfies DesignAsset;
      }
      document.structuredDataProbe = report.diagnostics?.structuredDataProbe ? {
        status: report.diagnostics.structuredDataProbe.status,
        resourceCount: report.diagnostics.structuredDataProbe.resourceCount,
        jsonResourceCount: report.diagnostics.structuredDataProbe.jsonResourceCount,
        parsedResourceCount: report.diagnostics.structuredDataProbe.parsedResourceCount,
        nodeCount: report.diagnostics.structuredDataProbe.nodeCount,
        assetCount: report.diagnostics.structuredDataProbe.assetCount,
        measurementCount: report.diagnostics.structuredDataProbe.measurementCount,
        notes: report.diagnostics.structuredDataProbe.notes
      } : undefined;
      for (const [index, asset] of (report.diagnostics?.structuredDataProbe?.assets ?? []).entries()) {
        const id = `lanhu-structured-asset:${index}:${asset.sourcePath}`;
        document.assets[id] = {
          id,
          name: asset.name || `结构化资源 ${index + 1}`,
          kind: asset.kind,
          width: asset.width,
          height: asset.height,
          mimeType: asset.kind === "image" ? "image/*" : undefined
        };
      }
      const rawMeasurementCandidates = (report.diagnostics?.annotationSummaries ?? [])
        .flatMap((annotation) => (annotation.measurements ?? [])
          .filter((measurement) => Number.isFinite(measurement.value) && measurement.value >= 0)
          .map((measurement) => ({
            value: measurement.value,
            unit: measurement.unit === "percent" ? "percent" as const : measurement.unit === "px" ? "px" as const : "number" as const,
            platformUnit: report.diagnostics?.platformContext?.designUnit,
            platform: report.diagnostics?.platformContext?.kind,
            sourceClass: annotation.className,
            confidence: "candidate" as const
          })));
      const measurementCandidates: DesignMeasurementCandidate[] = [
        ...new Map(
          rawMeasurementCandidates
            .map((candidate) => [`${candidate.value}:${candidate.unit}`, candidate] as const)
        ).values()
      ];
      document.measurementCandidates = measurementCandidates;
      document.revisions = [
        ...(previousDocument?.revisions ?? []),
        {
          version: document.syncVersion,
          syncedAt: document.syncedAt,
          sourceUrl: document.sourceUrl,
          capabilityStatus: document.capabilityReport.status,
          nodeCount: Object.keys(document.nodes).length,
          assetCount: Object.keys(document.assets).length
        }
      ].slice(-10);
      const previousRevisionSnapshots = [...(previousDocument?.revisionSnapshots ?? [])];
      if (
        previousDocument &&
        !previousRevisionSnapshots.some((snapshot) => snapshot.version === previousDocument.syncVersion)
      ) {
        previousRevisionSnapshots.push({
          version: previousDocument.syncVersion,
          syncedAt: previousDocument.syncedAt,
          sourceUrl: previousDocument.sourceUrl,
          capabilityStatus: previousDocument.capabilityReport.status,
          nodeCount: Object.keys(previousDocument.nodes).length,
          assetCount: Object.keys(previousDocument.assets).length,
          rootNodeIds: [...previousDocument.rootNodeIds],
          nodes: structuredClone(previousDocument.nodes),
          assets: structuredClone(previousDocument.assets),
          measurementCandidates: structuredClone(previousDocument.measurementCandidates)
        });
      }
      const currentRevisionSnapshot: DesignDocumentRevisionSnapshot = {
        version: document.syncVersion,
        syncedAt: document.syncedAt,
        sourceUrl: document.sourceUrl,
        capabilityStatus: document.capabilityReport.status,
        nodeCount: Object.keys(document.nodes).length,
        assetCount: Object.keys(document.assets).length,
        rootNodeIds: [...document.rootNodeIds],
        nodes: structuredClone(document.nodes),
        assets: structuredClone(document.assets),
        measurementCandidates: structuredClone(document.measurementCandidates)
      };
      document.revisionSnapshots = [...previousRevisionSnapshots, currentRevisionSnapshot].slice(-10);
      const nextDocuments = [document, ...documents.filter((item) => item.id !== document.id)].slice(0, 20);
      setDocuments(nextDocuments);
      const nextHistory = [record, ...history.filter((item) => item.report.pageUrl !== record.report.pageUrl)].slice(0, 10);
      await saveAppState({ history: nextHistory, documents: nextDocuments, contexts, currentDocumentId: document.id, currentNodeId: null });
      setHistory(nextHistory);
      setResult(record);
      setDocumentId(document.id);
      setSelectedNodeId(undefined);
      setActiveRevisionVersion(null);
      setActiveView("preview");
      setStatus(apiSyncResult?.status === "ready"
        ? `同步完成：已下载设计 JSON（${apiSyncResult.json_size ?? 0} bytes）`
        : record.report.status === "failed"
          ? "同步失败，请检查 Lake 页面地址"
          : `页面诊断已完成，设计 API 阶段为 ${apiSyncResult?.stage ?? "未执行"}`);
    } catch (error) {
      setStatus(`同步失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setIsSyncing(false);
    }
  }

  function exportReport() {
    if (!result) return;
    const blob = new Blob([reportMarkdown(result)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "lake-capability-report.md";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function exportConnectionDiagnostic() {
    const currentDocument = documentId ? documents.find((item) => item.id === documentId) : undefined;
    let currentBrowserUrl: string | null = null;
    let appVersion = "unknown";
    try {
      currentBrowserUrl = await invoke<string | null>("get_lanhu_browser_url");
    } catch {
      // The diagnostic remains useful when the native window is unavailable.
    }
    try {
      appVersion = await invoke<string>("app_info");
    } catch {
      // Keep the payload exportable during frontend-only development.
    }

    const assets = currentDocument ? Object.values(currentDocument.assets) : [];
    const assetStats = {
      total: assets.length || apiSyncResult?.assets.length || 0,
      downloadable: assets.filter((asset) => asset.downloadPolicy === "download-candidate").length,
      skippedDensityVariant: assets.filter((asset) => asset.downloadPolicy === "skip-density-variant").length,
      review: assets.filter((asset) => asset.downloadPolicy === "review").length,
      downloaded: assets.filter((asset) => asset.downloadStatus === "downloaded" || asset.downloadStatus === "cached").length,
      failed: assets.filter((asset) => asset.downloadStatus === "failed").length
    };
    const staleContexts = contexts.filter((context) => {
      const contextDocument = documents.find((item) => item.id === context.documentId);
      return Boolean(contextDocument && context.documentSyncedAt && context.documentSyncedAt !== contextDocument.syncedAt);
    }).length;
    const reportNotes = report?.notes ?? [];
    const apiNotes = apiSyncResult?.notes ?? [];
    const payload = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      app: {
        version: appVersion,
        adapterVersion: report?.adapterVersion ?? currentDocument?.adapterVersion ?? "unknown"
      },
      browser: {
        opened: Boolean(currentBrowserUrl) || browserOpened,
        currentUrl: diagnosticUrl(currentBrowserUrl ?? openedUrl),
        urlIsLake: Boolean(currentBrowserUrl && isLanhuUrl(currentBrowserUrl))
      },
      sync: {
        uiStatus: status,
        reportStatus: report?.status ?? "not-run",
        checkedAt: report?.checkedAt ?? null,
        apiStage: apiSyncResult?.stage ?? null,
        apiHttpStatus: apiSyncResult?.http_status ?? null,
        jsonSize: apiSyncResult?.json_size ?? null,
        pageIdentity: report?.pageIdentity ?? null,
        sourceUrl: diagnosticUrl(report?.pageUrl ?? openedUrl),
        notes: [...reportNotes, ...apiNotes].map(diagnosticText)
      },
      design: {
        documentId: currentDocument?.id ?? null,
        syncVersion: currentDocument?.syncVersion ?? null,
        nodeCount: currentDocument ? Object.keys(currentDocument.nodes).length : apiSyncResult?.layers.length ?? 0,
        assetStats,
        platform: report?.diagnostics?.platformContext ?? null,
        structuredDataStatus: currentDocument?.structuredDataProbe?.status ?? report?.diagnostics?.structuredDataProbe?.status ?? "not-run"
      },
      contexts: {
        total: contexts.length,
        stale: staleContexts
      },
      security: {
        credentialsIncluded: false,
        rawApiResponseIncluded: false,
        pageBodyIncluded: false,
        urlQueryValuesRedacted: true
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "lake-catch-connection-diagnostic.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("已导出脱敏连接诊断");
  }

  function exportDiagnosticLog() {
    const historySummary = history.slice(0, 10).map((item) => ({
      savedAt: item.savedAt,
      checkedAt: item.report.checkedAt,
      status: item.report.status,
      sourceUrl: diagnosticUrl(item.report.pageUrl),
      pageIdentity: item.report.pageIdentity ?? null
    }));
    const payload = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      entries: diagnosticLog.map((entry) => ({
        ...entry,
        detail: entry.detail ? diagnosticText(entry.detail) : undefined
      })),
      syncHistory: historySummary,
      security: {
        credentialsIncluded: false,
        rawApiResponseIncluded: false,
        pageBodyIncluded: false,
        urlQueryValuesRedacted: true,
        persisted: false
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "lake-catch-diagnostic-log.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("已导出脱敏诊断日志");
  }

  async function createCurrentContext(nodeId = selectedNodeId) {
    if (!documentId || !nodeId) return undefined;
    const document = viewedDocument;
    const selectedNode = document?.nodes[nodeId];
    if (!document || !selectedNode || !selectedNode.sourceRef?.startsWith("lake-json:")) return undefined;

    const nodeIds: string[] = [];
    const visit = (nodeId: string) => {
      const node = document.nodes[nodeId];
      if (!node) return;
      nodeIds.push(node.id);
      node.children.forEach(visit);
    };
    visit(selectedNode.id);
    const context: DesignContext = {
      id: `context:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`,
      documentId: document.id,
      documentSyncedAt: document.syncedAt,
      nodeIds,
      createdAt: new Date().toISOString(),
      label: selectedNode.name || "未命名图层"
    };
    const nextContexts = [context, ...contexts.filter((item) => item.id !== context.id)].slice(0, 50);
    setContexts(nextContexts);
    try {
      await saveAppState({ history, documents, contexts: nextContexts, currentDocumentId: documentId, currentNodeId: nodeId });
    } catch {
      // Keep the UI usable if persistence is temporarily unavailable. The current selection remains in memory.
    }
    setStatus(`已创建上下文：${context.label}（${nodeIds.length} 个节点）`);
    return context;
  }

  async function deliverCurrentNodeToAi(nodeId: string) {
    const document = viewedDocument;
    const selectedNode = document?.nodes[nodeId];
    if (!document || !selectedNode || !selectedNode.sourceRef?.startsWith("lake-json:")) {
      setStatus("当前选中的不是可交付的真实设计图层");
      return;
    }

    const context = await createCurrentContext(nodeId);
    if (!context) return;

    const handoff = [
      "请使用当前 Lake MCP 实现我刚交付的设计节点。",
      `设计稿：${document.title || "未命名设计稿"}`,
      `节点：${selectedNode.name || selectedNode.id}`,
      `contextId：${context.id}`,
      "请读取该 context 的结构化节点、官方视觉预览图和可用资源；然后按照我指定的目标平台实现，不要把整页预览图当作页面代码。"
    ].join("\n");

    try {
      await copyText(handoff);
      setStatus(`已交给 AI：${context.label}（${context.nodeIds.length} 个节点，交付信息已复制）`);
    } catch {
      setStatus(`已交给 AI：${context.label}（${context.nodeIds.length} 个节点）；交付信息复制失败，但 MCP 当前选区已更新`);
    }
  }

  async function copyImplementationReference(value: string, label: string) {
    try {
      await copyText(value);
      setStatus(`已复制${label}`);
    } catch {
      setStatus(`复制${label}失败，请手动选择并复制`);
    }
  }

  function selectNode(nodeId: string | undefined, nextDocumentId = documentId) {
    setSelectedNodeId(nodeId);
    void saveAppState({ history, documents, contexts, currentDocumentId: nextDocumentId, currentNodeId: nodeId ?? null });
  }

  async function configureCodexMcp() {
    if (isConfiguringMcp) return;
    setIsConfiguringMcp(true);
    try {
      const configPath = await invoke<string>("configure_codex_mcp");
      setStatus(`已将 Lake MCP 添加到 Codex：${configPath}。重启 Codex 后生效`);
    } catch (error) {
      setStatus(`添加 MCP 失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsConfiguringMcp(false);
    }
  }

  async function copyGenericMcpConfig() {
    try {
      const config = JSON.stringify(portableMcpConfig(), null, 2);
      await copyText(config);
      setStatus("已复制通用 MCP 配置；请先将 Lake Catch.app 放入 Applications 文件夹");
    } catch (error) {
      setStatus(`复制 MCP 配置失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const mcpConfigPreview = JSON.stringify(portableMcpConfig(), null, 2);

  function removeContext(contextId: string) {
    const nextContexts = contexts.filter((context) => context.id !== contextId);
    setContexts(nextContexts);
    void saveAppState({ history, documents, contexts: nextContexts, currentDocumentId: documentId, currentNodeId: selectedNodeId ?? null });
    setStatus("已删除 DesignContext");
  }

  function removeCurrentDocument() {
    if (!documentId) return;
    const currentDocument = documents.find((document) => document.id === documentId);
    const label = currentDocument?.title || documentId;
    if (!window.confirm(`确定删除本地设计文档“${label}”吗？同步历史不会被删除。`)) return;
    const nextDocuments = documents.filter((document) => document.id !== documentId);
    const nextContexts = contexts.filter((context) => context.documentId !== documentId);
    void saveAppState({ history, documents: nextDocuments, contexts: nextContexts, currentDocumentId: null, currentNodeId: null });
    setDocuments(nextDocuments);
    setContexts(nextContexts);
    setDocumentId(null);
    setSelectedNodeId(undefined);
    setActiveRevisionVersion(null);
    setStatus("已删除当前本地设计文档");
  }

  function clearDocuments() {
    if (documents.length === 0) return;
    if (!window.confirm(`确定清空 ${documents.length} 份本地设计文档吗？同步历史不会被删除。`)) return;
    void saveAppState({ history, documents: [], contexts: [], currentDocumentId: null, currentNodeId: null });
    setDocuments([]);
    setContexts([]);
    setDocumentId(null);
    setSelectedNodeId(undefined);
    setActiveRevisionVersion(null);
    setStatus("已清空本地设计文档");
  }

  async function cleanupAssetCache() {
    const referencedPaths = documents.flatMap((document) => Object.values(document.assets)
      .map((asset) => asset.localPath)
      .filter((path): path is string => Boolean(path)));
    try {
      const preview = await invoke<AssetCleanupResult>("cleanup_asset_cache", { referencedPaths, deleteOrphans: false });
      if (preview.stale_cache_entries === 0 && preview.orphan_files === 0) {
        setStatus("资源缓存检查完成：没有发现失效缓存或孤立文件");
        return;
      }
      const detail = `发现 ${preview.stale_cache_entries} 条失效缓存索引和 ${preview.orphan_files} 个未被当前文档引用的资源文件。`;
      if (preview.orphan_files === 0 || window.confirm(`${detail}\n只会删除应用资源目录中的孤立文件，继续清理吗？`)) {
        const cleaned = await invoke<AssetCleanupResult>("cleanup_asset_cache", { referencedPaths, deleteOrphans: true });
        setStatus(`资源缓存清理完成：移除 ${cleaned.stale_cache_entries} 条失效索引，删除 ${cleaned.removed_files} 个孤立文件`);
      } else {
        setStatus(`${detail} 已保留孤立文件`);
      }
    } catch (error) {
      setStatus(`资源缓存检查失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function recoverBlankBrowser(targetUrl: string) {
    // Creating a WebView only confirms the native window exists. On the first
    // login, WKWebView can finish the auth redirect with an empty document;
    // retry the same route without disturbing a visible login page.
    void (async () => {
      let hasUsablePage = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, attempt === 0 ? 1600 : 1000));
        try {
          const snapshot = await invoke<{
            url: string;
            dom_element_count: number;
            body_text_length: number;
          } | null>("get_lanhu_browser_snapshot");
          const blank = !snapshot || (snapshot.dom_element_count <= 3 && snapshot.body_text_length === 0);
          if (blank) {
            if (hasUsablePage || attempt >= 2) {
              await invoke("navigate_lanhu_browser", { url: targetUrl });
              setStatus("Lake 页面正在恢复加载…");
            }
            continue;
          }
          // Keep watching after a visible login page. The blank state can
          // happen only after the auth redirect finishes several seconds later.
          hasUsablePage = true;
        } catch {
          // The WebView can be between navigations. The next probe will retry.
        }
      }
    })();
  }

  async function clearLakeSession() {
    setStatus("正在清除 Lake 登录状态…");
    try {
      await invoke("clear_lanhu_session");
      setBrowserOpened(false);
      setStatus("Lake 登录状态已清除，下次打开可重新登录");
    } catch (error) {
      setStatus(`清除 Lake 登录状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function focusLanhu() {
    try {
      const focused = await invoke<boolean>("focus_lanhu_browser");
      setStatus(focused ? "已切换到 Lake 设计稿窗口" : "Lake 设计稿窗口尚未打开");
    } catch (error) {
      setStatus(`切换 Lake 窗口失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function openLanhu() {
    const requestedUrl = pageUrl.trim();
    if (!requestedUrl) {
      setStatus("Lake 页面打开失败：请先输入页面地址");
      return;
    }

    setOpenedUrl(requestedUrl);
    try {
      setActiveView("browser");
      setStatus(requestedUrl === lakeHomeUrl ? "正在打开 Lake 首页…" : "正在打开 Lake 设计稿…");
      await invoke("open_lanhu_browser", {
        url: requestedUrl
      });
      setBrowserOpened(true);
      try {
        localStorage.setItem(lastOpenedUrlKey, requestedUrl);
      } catch {
        // The address remains usable even if browser storage is unavailable.
      }
      setStatus(requestedUrl === lakeHomeUrl
        ? "Lake 首页正在加载，请在内置页面中登录并打开设计稿"
        : "Lake 设计稿正在加载…");
      recoverBlankBrowser(requestedUrl);
    } catch (error) {
      setBrowserOpened(false);
      if (error instanceof Error && error.message) {
        setStatus(`Lake 页面打开失败：${error.message}`);
      } else {
        setStatus("Lake 页面暂时无法打开，请确认运行在 Tauri 桌面应用中");
      }
    }
  }

  const selectedDocument = documentId ? documents.find((item) => item.id === documentId) : undefined;
  const viewedDocument = selectedDocument && activeRevisionVersion
    ? (() => {
        const snapshot = selectedDocument.revisionSnapshots?.find((item) => item.version === activeRevisionVersion);
        return snapshot ? { ...selectedDocument, syncVersion: snapshot.version, syncedAt: snapshot.syncedAt, rootNodeIds: snapshot.rootNodeIds, nodes: snapshot.nodes, assets: snapshot.assets, measurementCandidates: snapshot.measurementCandidates } : selectedDocument;
      })()
    : selectedDocument;
  const platformContext = report?.diagnostics?.platformContext;

  return (
    <main className={`shell ${isPreviewFocused ? "is-preview-focused" : ""}`}>
      <div className="shell-chrome" aria-hidden={isPreviewFocused}>
        <div className="shell-chrome-inner">
          <section className="unified-toolbar panel" aria-label="页面与 AI 工具连接">
            <div className="unified-url-field">
              <span className="unified-url-icon" aria-hidden="true">⌁</span>
              <label className="sr-only" htmlFor="lanhu-url">Lake 页面地址</label>
              <input id="lanhu-url" value={pageUrl} onChange={(event) => setPageUrl(event.target.value)} />
            </div>
            <div className="unified-page-actions">
              <button onClick={openLanhu}>打开 Lake</button>
              <button className={`primary unified-sync-button ${isSyncing ? "is-syncing" : ""}`} onClick={syncCurrentPage} disabled={isSyncing || !openedUrl || !isLanhuUrl(openedUrl)}>
                {isSyncing && <span className="spinner" aria-hidden="true" />}
                {isSyncing ? "正在同步…" : "同步当前页面"}
              </button>
            </div>
            <span className="unified-toolbar-divider" aria-hidden="true" />
            <div className="unified-mcp-actions">
              <span className="mcp-connection-status"><span className="mcp-status-dot" aria-hidden="true" />MCP · stdio</span>
              <button className="primary" onClick={() => void configureCodexMcp()} disabled={isConfiguringMcp}>
                {isConfiguringMcp ? "正在配置…" : "添加到 Codex"}
              </button>
              <details className="unified-more">
                <summary title="更多连接选项" aria-label="更多连接选项">···</summary>
                <div className="unified-more-menu">
                  <button onClick={() => void copyGenericMcpConfig()}>复制通用配置</button>
                  <details className="unified-config-details">
                    <summary>查看 MCP JSON</summary>
                    <div className="unified-config-content">
                      <pre className="mcp-config" aria-label="通用 MCP 配置"><code>{mcpConfigPreview}</code></pre>
                      <p className="mcp-note">Codex 点击后重启即可生效；其他 AI 工具粘贴这段 JSON 到它们的 MCP 配置中。应用会先备份原有 Codex 配置，不会保存登录信息。</p>
                    </div>
                  </details>
                </div>
              </details>
            </div>
          </section>
        </div>
      </div>

      <section className={`workspace ${isLayerInspectorCollapsed ? "is-layer-inspector-collapsed" : ""}`}>
        <aside className="layer-inspector-panel panel">
          <LayerInspector
            document={viewedDocument}
            selectedNodeId={selectedNodeId}
            collapsed={isLayerInspectorCollapsed}
            onToggleCollapsed={() => setIsLayerInspectorCollapsed((collapsed) => !collapsed)}
            onSelect={(nodeId) => { selectNode(nodeId); setActiveView("preview"); }}
            onCopyReference={(value, label) => void copyImplementationReference(value, label)}
          />
        </aside>
        <div className="browser panel">
          <div className="panel-heading panel-heading-stack">
            <div className="view-tabs" role="tablist" aria-label="主视图">
              <button className={`view-tab ${activeView === "browser" ? "selected" : ""}`} onClick={() => setActiveView("browser")} role="tab" aria-selected={activeView === "browser"}>内置浏览</button>
              <button className={`view-tab ${activeView === "preview" ? "selected" : ""}`} onClick={() => setActiveView("preview")} role="tab" aria-selected={activeView === "preview"} disabled={!report}>设计预览</button>
            </div>
            <span className="status">{status}</span>
          </div>
          {activeView === "preview" && report ? (
            <DesignPreview
              document={viewedDocument}
              platform={platformContext}
              measurementCandidates={viewedDocument?.measurementCandidates ?? []}
              selectedNodeId={selectedNodeId}
              onSelectNode={(nodeId) => { selectNode(nodeId); setActiveView("preview"); }}
              onDeliverNode={deliverCurrentNodeToAi}
              isFocused={isPreviewFocused}
              onToggleFocus={() => setIsPreviewFocused((focused) => !focused)}
            />
          ) : (
            <div className="browser-content">
              <div className="browser-placeholder">
                <div className={`browser-indicator ${browserOpened ? "is-open" : ""}`} aria-hidden="true" />
                <h3>{browserOpened ? "Lake 页面已打开" : "Lake 页面尚未打开"}</h3>
                <p>{browserOpened
                  ? "设计稿正在独立窗口中显示。主窗口保留同步、诊断和设计预览功能。"
                  : "点击打开后，设计稿会在独立窗口中显示。登录状态会保存在应用内。"}</p>
                <div className="browser-actions">
                  {browserOpened
                    ? <button className="primary" onClick={() => void focusLanhu()}>切换到 Lake 窗口</button>
                    : <button className="primary" onClick={openLanhu}>打开 Lake 页面</button>}
                  <button onClick={() => void clearLakeSession()}>清除登录状态</button>
                </div>
                <div className="opened-url">{openedUrl}</div>
                {lastBrowserUrlSyncAt && <div className="browser-sync-note">最近检测到页面切换：{formatTime(lastBrowserUrlSyncAt)}</div>}
              </div>
            </div>
          )}
        </div>
        <aside className="report panel">
          <div className="panel-heading"><h2>能力报告</h2><div className="heading-actions"><span className="status">{report?.status ?? "not-run"}</span><button className="small-button" onClick={() => void exportConnectionDiagnostic()}>连接诊断</button><button className="small-button" onClick={exportDiagnosticLog}>导出日志</button><button className="small-button" onClick={exportReport} disabled={!report}>导出</button></div></div>
          <div className="report-scroll">
            {apiSyncResult && (
              <div className={`api-sync-summary ${apiSyncResult.status === "ready" ? "is-ready" : "is-failed"}`}>
              <div className="api-sync-summary-heading">
                <strong>{apiSyncResult.status === "ready" ? "设计 JSON 已接入" : "设计 API 未完成"}</strong>
                <span>{apiSyncResult.stage}</span>
              </div>
              {apiSyncResult.status === "ready" ? (
                <>
                  <div className="api-sync-stats">
                    <span>大小 {apiSyncResult.json_size ?? 0} bytes</span>
                    <span>HTTP {apiSyncResult.http_status ?? "-"}</span>
                    <span>图层 {apiSyncResult.layers.length}</span>
                    <span>资源 {apiSyncResult.assets.length}</span>
                    <span>有 URL {apiSyncResult.assets.filter((asset) => Boolean(asset.source_url)).length}</span>
                    <span>跳过 mdpi/hdpi {apiSyncResult.assets.filter((asset) => asset.download_policy === "skip-density-variant").length}</span>
                    <span>待复核 {apiSyncResult.assets.filter((asset) => asset.download_policy === "review").length}</span>
                  </div>
                  <p>{apiSyncResult.notes.join("；") || "API/设计 JSON 是本次同步的确认数据源。"}</p>
                </>
              ) : (
                <p>{apiSyncResult.notes.join("；")}</p>
              )}
            </div>
          )}
            {report ? (
              <>
              <dl className="metadata">
                <div><dt>页面标题</dt><dd>{report.pageTitle}</dd></div>
                <div><dt>页面地址</dt><dd>{report.pageUrl}</dd></div>
                <div><dt>同步时间</dt><dd>{formatTime(report.checkedAt)}</dd></div>
                {report.diagnostics?.platformContext && (
                  <div>
                    <dt>当前平台</dt>
                    <dd>
                      {report.diagnostics.platformContext.label ?? report.diagnostics.platformContext.kind}
                      {report.diagnostics.platformContext.viewportWidth && report.diagnostics.platformContext.contentHeight
                        ? ` · 页面 ${report.diagnostics.platformContext.viewportWidth}${report.diagnostics.platformContext.designUnit} × ${report.diagnostics.platformContext.contentHeight}${report.diagnostics.platformContext.designUnit}${report.diagnostics.platformContext.scrollable ? "（可滚动）" : ""}`
                        : ""}
                      {` · 目标单位 ${report.diagnostics.platformContext.designUnit}（候选）`}
                    </dd>
                  </div>
                )}
              </dl>
              <details className="report-details">
                <summary>技术诊断与页面标识</summary>
                <dl className="metadata metadata-secondary">
                  {documentId && <div><dt>本地文档 ID</dt><dd>{documentId}</dd></div>}
                  {report.pageIdentity && Object.entries(report.pageIdentity).filter(([, value]) => value).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
                </dl>
                {report.diagnostics && (
                  <section className="diagnostics-block" aria-label="页面诊断">
                    <div className="section-heading"><h3>页面诊断</h3><span>{report.diagnostics.renderSurface} · {report.diagnostics.readyState}</span></div>
                    <div className="diagnostic-grid">
                      <div><strong>{report.diagnostics.domElementCount}</strong><span>DOM 元素</span></div>
                      <div><strong>{report.diagnostics.nodeMarkerCount}</strong><span>节点候选</span></div>
                      <div><strong>{report.diagnostics.semanticElementCount}</strong><span>语义元素</span></div>
                      <div><strong>{report.diagnostics.contentEditableCount}</strong><span>可编辑</span></div>
                      <div><strong>{report.diagnostics.bodyTextLength}</strong><span>正文字符</span></div>
                      <div><strong>{report.diagnostics.imageCount}</strong><span>图片</span></div>
                      <div><strong>{report.diagnostics.canvasCount}</strong><span>Canvas</span></div>
                      <div><strong>{report.diagnostics.svgCount}</strong><span>SVG</span></div>
                      <div><strong>{report.diagnostics.iframeCount}</strong><span>iframe</span></div>
                      <div><strong>{report.diagnostics.visibleSurfaceSummaries?.length ?? 0}</strong><span>可见区域</span></div>
                    </div>
                    <p className="document-note">仅记录页面结构计数，不保存正文、Cookie、Token 或具体设计节点。</p>
                    {report.diagnostics.structuredDataProbe && (
                      <div className="structured-probe">
                        <div className="section-heading"><h3>结构化数据探针</h3><span>{report.diagnostics.structuredDataProbe.status}</span></div>
                        <div className="document-stats">
                          <div><strong>{report.diagnostics.structuredDataProbe.parsedResourceCount}</strong><span>已解析 JSON</span></div>
                          <div><strong>{report.diagnostics.structuredDataProbe.nodeCount}</strong><span>图层候选</span></div>
                          <div><strong>{report.diagnostics.structuredDataProbe.assetCount}</strong><span>资源候选</span></div>
                        </div>
                        <p className="document-note">当前候选来自 Lake 已加载的同源结构化资源，仍需确认 Schema 字段语义；原始响应不会保存。</p>
                      </div>
                    )}
                  </section>
                )}
              </details>
              <section className="document-block" aria-label="本地设计文档">
                <div className="section-heading">
                  <h3>本地设计文档</h3>
                  <span>{documents.length} 份</span>
                </div>
                {documentId ? (() => {
                  const document = viewedDocument;
                  if (!document) return <p className="document-note">当前同步结果没有对应的本地设计文档。</p>;
                  const nodeCount = document ? Object.keys(document.nodes).length : 0;
                  const assetCount = document ? Object.keys(document.assets).length : 0;
                  const assetValues = document ? Object.values(document.assets) : [];
                  const downloadableAssetCount = assetValues.filter((asset) => asset.downloadPolicy === "download-candidate").length;
                  const skippedDensityAssetCount = assetValues.filter((asset) => asset.downloadPolicy === "skip-density-variant").length;
                  const reviewAssetCount = assetValues.filter((asset) => asset.downloadPolicy === "review").length;
                  const downloadedAssetCount = assetValues.filter((asset) => asset.downloadStatus === "downloaded").length;
                  const cachedAssetCount = assetValues.filter((asset) => asset.downloadStatus === "cached").length;
                  const failedAssetCount = assetValues.filter((asset) => asset.downloadStatus === "failed").length;
                  const syncVersion = document.syncVersion ?? 1;
                  const revisionCount = document.revisions?.length ?? 1;
                  const documentContexts = contexts.filter((context) => context.documentId === document.id);
                  const usableContexts = documentContexts.filter((context) => !context.documentSyncedAt || context.documentSyncedAt === document.syncedAt);
                  const confirmedNodeCount = Object.values(document.nodes).filter((node) => node.sourceRef?.startsWith("lake-json:")).length;
                  const implementationStatus = confirmedNodeCount > 0 ? "可供 AI 使用" : "等待确认设计 JSON";
                  return (
                    <>
                      <section className={`implementation-status ${confirmedNodeCount > 0 ? "is-ready" : "is-partial"}`} aria-label="AI 实现上下文状态">
                        <div className="implementation-status-summary">
                          <div>
                            <strong>当前设计稿{implementationStatus}</strong>
                            <span>{nodeCount} 个节点 · {assetCount} 个资源</span>
                          </div>
                          <span className="implementation-status-indicator" aria-hidden="true" />
                        </div>
                        <details className="implementation-details">
                          <summary>技术详情</summary>
                          <div className="implementation-reference">
                            <div>
                              <strong>整页文档</strong>
                              <code>{document.id}</code>
                            </div>
                            <div className="implementation-reference-actions">
                              <em>get_implementation_context · documentId</em>
                              <button className="small-button" onClick={() => void copyImplementationReference(document.id, "文档 ID")}>复制 ID</button>
                            </div>
                          </div>
                          <div className="implementation-reference-list">
                            {usableContexts.slice(0, 6).map((context) => (
                              <div className="implementation-reference" key={context.id}>
                                <div>
                                  <strong>{context.label || "局部上下文"}</strong>
                                  <code>{context.id}</code>
                                </div>
                                <div className="implementation-reference-actions">
                                  <em>{context.nodeIds.length} 个节点 · contextId</em>
                                  <button className="small-button" onClick={() => void copyImplementationReference(context.id, "context ID")}>复制 ID</button>
                                </div>
                              </div>
                            ))}
                          </div>
                          <p className="document-note">
                            已确认 {confirmedNodeCount}/{nodeCount} 个节点。AI 可用整页文档，或使用未过期的局部 context；重新同步后旧 context 会标记为过期。
                          </p>
                          <div className="document-stats implementation-stats">
                            <div><strong>{nodeCount}</strong><span>节点</span></div>
                            <div><strong>{assetCount}</strong><span>资源</span></div>
                            <div><strong>{downloadableAssetCount}</strong><span>可下载</span></div>
                            <div><strong>{skippedDensityAssetCount}</strong><span>跳过 mdpi/hdpi</span></div>
                            <div><strong>{reviewAssetCount}</strong><span>待确认</span></div>
                            <div><strong>{downloadedAssetCount + cachedAssetCount}</strong><span>本地可用</span></div>
                            <div><strong>{failedAssetCount}</strong><span>下载失败</span></div>
                            <div><strong>{document?.pageIds.length ?? 0}</strong><span>页面</span></div>
                          </div>
                          <p className="document-note">当前同步版本 v{syncVersion}，保留 {revisionCount} 个版本摘要。已保存 {nodeCount} 个设计节点候选和 {assetCount} 个资源候选。明确为 mdpi/hdpi 的资源暂不进入下载队列，未知密度资源需要复核。</p>
                        </details>
                      </section>
                      {revisionCount > 1 && (
                        <div className="revision-list" aria-label="同步版本">
                          {document.revisions?.slice().reverse().map((revision) => (
                            <button className={`revision-list-item ${revision.version === (activeRevisionVersion ?? syncVersion) ? "is-current" : ""}`} key={`${revision.version}:${revision.syncedAt}`} onClick={() => setActiveRevisionVersion(revision.version)}>
                              <strong>v{revision.version}</strong>
                              <span>{formatTime(revision.syncedAt)}</span>
                              <span>{revision.nodeCount} 节点 · {revision.assetCount} 资源</span>
                              <em>{revision.version === (activeRevisionVersion ?? syncVersion) ? "当前查看" : revision.capabilityStatus}</em>
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="document-actions">
                        <button className="small-button" onClick={() => void cleanupAssetCache()}>检查资源缓存</button>
                        <button className="small-button danger" onClick={removeCurrentDocument}>删除当前文档</button>
                        <button className="small-button" onClick={clearDocuments} disabled={documents.length === 0}>清空本地文档</button>
                      </div>
                      <section className="contexts-block" aria-label="DesignContext">
                        <div className="section-heading">
                          <h3>DesignContext</h3>
                          <span>{documentContexts.length} 个</span>
                        </div>
                        <button
                          className="small-button context-create-button"
                          onClick={() => { void createCurrentContext(); }}
                          disabled={!selectedNodeId || !document.nodes[selectedNodeId]?.sourceRef?.startsWith("lake-json:")}
                        >
                          从当前图层创建上下文
                        </button>
                        <p className="document-note">上下文包含当前图层及其全部子节点，供 MCP 持久化读取。</p>
                        <div className="context-list">
                          {contexts.filter((context) => context.documentId === document.id).map((context) => (
                            <div className={`context-item ${context.documentSyncedAt && context.documentSyncedAt !== document.syncedAt ? "is-stale" : ""}`} key={context.id}>
                              <div>
                                <strong>{context.label || "未命名上下文"}</strong>
                                <span>{context.nodeIds.length} 个节点 · {formatTime(context.createdAt)}</span>
                                {context.documentSyncedAt && context.documentSyncedAt !== document.syncedAt && <em>对应旧版本，建议重新创建</em>}
                                <code>{context.id}</code>
                              </div>
                              <button className="small-button danger" onClick={() => removeContext(context.id)} aria-label={`删除 ${context.label || "上下文"}`}>删除</button>
                            </div>
                          ))}
                          {contexts.filter((context) => context.documentId === document.id).length === 0 && <p className="document-note">尚未创建上下文。先在图层树或预览中选中一个真实图层。</p>}
                        </div>
                      </section>
                    </>
                  );
                })() : (
                  <p className="document-note">当前同步结果没有对应的本地设计文档。</p>
                )}
              </section>
              <details className="report-details">
                <summary>能力明细与同步说明</summary>
                <div className="capabilities">
                  {capabilityRows.map(({ key, enabled }) => <div className="capability" key={key}><span>{key}</span><strong className={enabled ? "yes" : "no"}>{enabled ? "已具备" : "待验证"}</strong></div>)}
                </div>
                <ul className="notes">{report.notes.map((note) => <li key={note}>{note}</li>)}</ul>
              </details>
              <div className="history-block">
                <h3>最近同步</h3>
                {history.map((item) => <button className={`history-item ${item.request.requestId === result?.request.requestId ? "selected" : ""}`} key={item.request.requestId} onClick={() => { setResult(item); setActiveRevisionVersion(null); const nextDocumentId = documentIdFor(item); setDocumentId(nextDocumentId); const nextNodeId = documents.find((document) => document.id === nextDocumentId)?.rootNodeIds[0]; selectNode(nextNodeId, nextDocumentId); setOpenedUrl(item.report.pageUrl); setStatus("已切换到历史同步结果"); }}><span>{item.report.pageTitle}</span><time>{formatTime(item.savedAt)}</time></button>)}
              </div>
              </>
            ) : <p className="empty">点击“同步当前页面”生成第一份能力报告。</p>}
          </div>
        </aside>
      </section>
    </main>
  );
}
