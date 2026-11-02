// The MCP package intentionally keeps Node types out of the shared browser packages.
// @ts-ignore Node resolves this built-in module at runtime.
import { access, readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import type {
  DesignAsset,
  DesignContext,
  DesignPageElement,
  DesignDocument,
  DesignNavigationItem,
  DesignPageStructure,
  DesignNode
} from "@lake/design-model";

declare const process: {
  env: Record<string, string | undefined>;
  stdin: { on(event: string, listener: (chunk: Uint8Array) => void): void };
  stdout: { write(value: string): boolean };
};

interface AppState {
  documents?: DesignDocument[];
  contexts?: DesignContext[];
  currentDocumentId?: string | null;
  currentNodeId?: string | null;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const tools: ToolDefinition[] = [
  tool("list_design_documents", "列出本地已同步的设计文档。", {}),
  tool("get_current_selection", "读取桌面应用当前选中的设计文档、节点和有上限的节点子树；没有选中节点时返回当前文档。", { maxDepth: numberProperty(), maxNodes: numberProperty() }),
  tool("get_design_document", "读取一份设计文档及其来源和能力可信度。", { documentId: stringProperty() }, ["documentId"]),
  tool("get_node_tree", "读取设计文档中的已确认节点树。", { documentId: stringProperty(), maxDepth: numberProperty() }, ["documentId"]),
  tool("get_node", "读取一个已确认设计节点。", { documentId: stringProperty(), nodeId: stringProperty() }, ["documentId", "nodeId"]),
  tool("get_design_specs", "读取标注/规格候选，并保留 candidate 可信度。", { documentId: stringProperty() }, ["documentId"]),
  tool("get_current_implementation_context", "读取最近一次同步的当前设计稿实现上下文；无须提供 documentId，适合 AI 工具直接获取当前设计稿。可选传入 contextId 读取指定局部模块。", { contextId: stringProperty(), maxDepth: numberProperty(), maxNodes: numberProperty() }),
  tool("get_implementation_context", "生成面向 AI 实现 UI 的紧凑设计上下文，包含平台、页面尺寸、节点规格、文字、样式、资源和不确定项；优先传入 contextId。", { documentId: stringProperty(), contextId: stringProperty(), maxDepth: numberProperty(), maxNodes: numberProperty() }),
  tool("list_assets", "列出设计文档中已确认的资源引用。", { documentId: stringProperty() }, ["documentId"]),
  tool("get_asset", "读取一项设计资源引用。", { documentId: stringProperty(), assetId: stringProperty() }, ["documentId", "assetId"]),
  tool("get_design_preview", "读取当前或指定设计稿的官方整页视觉预览图；用于将结构化设计数据与原始视觉结果结合，避免人工截图。", { documentId: stringProperty() }),
  tool("list_design_contexts", "列出本地持久化的 DesignContext。", {}),
  tool("create_design_context", "在当前 MCP 进程中创建一个只读节点 context。", { documentId: stringProperty(), nodeIds: arrayProperty(), label: stringProperty() }, ["documentId", "nodeIds"]),
  tool("get_design_context", "读取本地持久化或当前 MCP 进程中的只读节点 context。", { contextId: stringProperty(), maxDepth: numberProperty(), maxNodes: numberProperty() }, ["contextId"])
];

const contexts = new Map<string, DesignContext>();

function tool(name: string, description: string, properties: Record<string, unknown>, required?: string[]): ToolDefinition {
  return { name, description, inputSchema: { type: "object", properties, ...(required ? { required } : {}) } };
}

function stringProperty() { return { type: "string" }; }
function numberProperty() { return { type: "number", minimum: 0 }; }
function arrayProperty() { return { type: "array", items: { type: "string" } }; }

function statePath() {
  return process.env.LANHU_STATE_PATH ?? `${process.env.HOME ?? ""}/Library/Application Support/com.lake.catch/state.json`;
}

async function appState(): Promise<AppState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8")) as AppState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function documents(): Promise<DesignDocument[]> {
  const state = await appState();
  return Array.isArray(state.documents) ? state.documents.map(normalizeDocument) : [];
}

function normalizeDocument(document: DesignDocument): DesignDocument {
  const nodes = Object.fromEntries(Object.entries(document.nodes).map(([id, node]) => [id, normalizeLegacyText(node)]));
  const normalized = { ...document, nodes };
  // Recompute inferred structure for every read. It is derived from the current
  // node tree, so keeping a stale persisted copy would make algorithm fixes
  // invisible until the design is synchronized again.
  const inferredPageStructure = derivePageStructure(normalized);
  return {
    ...normalized,
    pageStructure: inferredPageStructure ?? document.pageStructure
  };
}

function normalizeLegacyText(node: DesignNode): DesignNode {
  const isConfirmedText = node.sourceRef?.startsWith("lake-json:") && node.type.toLowerCase().includes("text");
  if (!isConfirmedText || node.text || !node.name.trim()) return node;
  return { ...node, text: node.name };
}

function nodeLabel(node: DesignNode) {
  return (node.text ?? node.name).trim();
}

function derivePageStructure(document: DesignDocument): DesignPageStructure | undefined {
  const nodes = Object.values(document.nodes).filter((node) => node.sourceRef?.startsWith("lake-json:"));
  if (nodes.length === 0) return undefined;

  const byId = document.nodes;
  const headerNode = findHeaderNode(document, nodes, byId);
  const root = document.rootNodeIds.map((id) => byId[id]).find(Boolean);
  const rootLabel = root ? nodeLabel(root) : "";
  const tabGroups = findTabGroups(nodes, byId, headerNode);
  const primaryGroup = tabGroups[0] ?? [];
  const primaryTabs: DesignNavigationItem[] = primaryGroup.map((node) => ({
    id: nodeLabel(node).toLowerCase().replace(/\s+/g, "-"),
    label: nodeLabel(node),
    nodeId: node.id,
    parentId: node.parentId,
    confidence: "candidate"
  }));

  const secondaryGroup = tabGroups.find((group) => group[0]?.parentId !== primaryGroup[0]?.parentId && group.length >= 2) ?? [];
  const secondaryNodes = secondaryGroup;
  const commonSecondaryParent = secondaryNodes.length >= 2
    ? findCommonAncestor(secondaryNodes.map((node) => node.id), byId)
    : secondaryNodes[0]?.parentId;
  const secondaryTabs: DesignNavigationItem[] = secondaryNodes
    .filter((node) => commonSecondaryParent ? isDescendantOf(node.id, commonSecondaryParent, byId) : true)
    .sort((left, right) => (left.bounds?.x ?? 0) - (right.bounds?.x ?? 0))
    .map((node) => ({
      id: nodeLabel(node).toLowerCase(),
      label: nodeLabel(node),
      nodeId: node.id,
      parentId: commonSecondaryParent,
      parentTab: primaryTabs.length === 1 ? primaryTabs[0].label : undefined,
      confidence: "candidate"
    }));

  if (!headerNode && primaryTabs.length === 0 && secondaryTabs.length === 0) return undefined;

  const headerElements: DesignPageElement[] = headerNode
    ? collectDescendants(headerNode.id, byId)
      .filter((node) => node.id !== headerNode.id && node.bounds && node.bounds.width > 0 && node.bounds.height > 0)
      .filter((node) => {
        const label = nodeLabel(node);
        const type = node.type.toLowerCase();
        return Boolean(node.text) || Boolean(node.assetUrl) || type.includes("bitmap") || type.includes("symbol") || /back|close|favorite|bookmark|logo|brand|badge|avatar|icon|arrow|chevron|menu|search|select|dropdown|picker|tab|nav|status|toolbar|header|top/i.test(label);
      })
      .reduce((elements, node) => {
        const label = nodeLabel(node);
        const role = headerElementRole(label);
        const key = `${role}:${node.bounds?.x}:${node.bounds?.y}:${node.bounds?.width}:${node.bounds?.height}`;
        const element: DesignPageElement = {
          id: `${role}-${node.id}`,
          label,
          role,
          nodeId: node.id,
          type: node.type,
          bounds: node.bounds,
          assetUrl: node.assetUrl,
          required: true,
          confidence: "candidate"
        };
        const existingIndex = elements.findIndex((candidate) => candidate.key === key);
        if (existingIndex < 0) {
          elements.push({ key, element });
        } else if (!elements[existingIndex].element.assetUrl && element.assetUrl) {
          elements[existingIndex] = { key, element };
        }
        return elements;
      }, [] as Array<{ key: string; element: DesignPageElement }>)
      .map(({ element }) => element)
    : [];

  const requiredElementRoles = [...new Set(headerElements
    .filter((element) => element.required && element.role && element.role !== "unknown")
    .map((element) => element.role!))];

  return {
    pageName: rootLabel || (headerNode ? "Page" : undefined),
    header: headerNode ? {
      label: headerNode.name && !isStructuralHeaderName(headerNode.name) ? nodeLabel(headerNode) : "Header",
      nodeId: headerNode.id,
      bounds: headerNode.bounds,
      elements: headerElements,
      requiredElementRoles: [...requiredElementRoles],
      confidence: "candidate"
    } : undefined,
    primaryTabs,
    secondaryTabs,
    confidence: "candidate",
    source: "inferred",
    notes: [
      "页面结构由已确认的设计 JSON 图层和几何关系启发式推导，不是由画板名称单独推断。",
      "header、一级 Tab、二级 Tab 和元素角色均为候选结构；调用方应结合节点 bounds、样式和资源复核。",
      "当前 Tab 选中状态未从文档标题猜测；只有来源数据明确提供选中状态时才应设置 selectedPrimaryTab/selectedSecondaryTab。"
    ]
  };
}

function headerElementRole(label: string): DesignPageElement["role"] {
  const normalized = label.trim().toLowerCase();
  if (/^\d{1,2}:\d{2}$/.test(normalized)) return "status-time";
  if (/(^|[/_-])(back|close|返回|关闭)([/_-]|$)/i.test(normalized)) return "back-button";
  if (/(favorite|收藏|bookmark|star)/i.test(normalized)) return "favorite-button";
  if (/(logo|badge|avatar|brand|icon[/_-].*(logo|brand)|徽标|头像)/i.test(normalized)) return "brand-mark";
  if (/(select|selector|dropdown|picker|switcher|下拉|选择|筛选)/i.test(normalized)) return "selector";
  if (/^\d[\d,.]*([km万亿])?$/i.test(normalized)) return "count";
  if (/(status|time|时间|状态)/i.test(normalized)) return "status-time";
  return "unknown";
}

function isStructuralHeaderName(name: string) {
  return /(^|[/_-])(header|top|toolbar|navbar|navigation|statusbar)([/_-]|$)/i.test(name);
}

function findHeaderNode(document: DesignDocument, nodes: DesignNode[], byId: Record<string, DesignNode>) {
  const root = document.rootNodeIds.map((id) => byId[id]).find((node) => node?.bounds);
  const candidates = nodes.filter((node) => {
    if (!node.bounds || !root?.bounds) return false;
    const nearTop = node.bounds.y <= root.bounds.y + Math.max(24, root.bounds.height * 0.05);
    const spansViewport = node.bounds.width >= root.bounds.width * 0.8;
    const plausibleHeight = node.bounds.height > 0 && node.bounds.height <= root.bounds.height * 0.35;
    return nearTop && spansViewport && plausibleHeight;
  });
  return candidates.sort((left, right) => {
    const named = Number(isStructuralHeaderName(right.name)) - Number(isStructuralHeaderName(left.name));
    if (named !== 0) return named;
    return (left.bounds?.height ?? 0) - (right.bounds?.height ?? 0);
  })[0];
}

function findTabGroups(nodes: DesignNode[], byId: Record<string, DesignNode>, headerNode?: DesignNode) {
  const groups: DesignNode[][] = [];
  const headerBottom = headerNode?.bounds ? headerNode.bounds.y + headerNode.bounds.height : 0;
  const tabSearchEnd = headerNode?.bounds
    ? headerBottom + Math.max(160, headerNode.bounds.height)
    : Number.POSITIVE_INFINITY;
  const candidates = nodes
    .filter((node) => node.bounds && nodeLabel(node) && isTextLike(node) && node.bounds.y >= headerBottom - 8 && node.bounds.y <= tabSearchEnd)
    .sort((left, right) => (left.bounds?.y ?? 0) - (right.bounds?.y ?? 0) || (left.bounds?.x ?? 0) - (right.bounds?.x ?? 0));
  for (const node of candidates) {
    const existing = groups.find((group) => sameHorizontalBand(group, node) && noLargeGap(group, node));
    if (existing) existing.push(node);
    else groups.push([node]);
  }
  return groups
    .filter((group) => group.length >= 2 && looksLikeTabGroup(group, byId))
    .map((group) => group.sort((left, right) => (left.bounds?.x ?? 0) - (right.bounds?.x ?? 0)))
    .sort((left, right) => {
      const leftY = Math.min(...left.map((node) => node.bounds?.y ?? 0));
      const rightY = Math.min(...right.map((node) => node.bounds?.y ?? 0));
      return leftY - rightY || right.length - left.length;
    });
}

function isTextLike(node: DesignNode) {
  return Boolean(node.text) || node.type.toLowerCase().includes("text");
}

function sameHorizontalBand(group: DesignNode[], node: DesignNode) {
  const yValues = group.map((item) => item.bounds?.y ?? 0);
  const heights = group.map((item) => item.bounds?.height ?? 0);
  const tolerance = Math.max(4, Math.max(...heights, node.bounds?.height ?? 0) * 0.35);
  return Math.abs((node.bounds?.y ?? 0) - Math.max(...yValues)) <= tolerance;
}

function noLargeGap(group: DesignNode[], node: DesignNode) {
  const last = [...group].sort((left, right) => (left.bounds?.x ?? 0) - (right.bounds?.x ?? 0)).at(-1);
  if (!last?.bounds || !node.bounds) return false;
  const gap = node.bounds.x - (last.bounds.x + last.bounds.width);
  return gap <= Math.max(96, last.bounds.height * 6);
}

function looksLikeTabGroup(group: DesignNode[], byId: Record<string, DesignNode>) {
  const yValues = group.map((node) => node.bounds?.y ?? 0);
  const heights = group.map((node) => node.bounds?.height ?? 0);
  const sameRow = Math.max(...yValues) - Math.min(...yValues) <= Math.max(8, Math.max(...heights) * 0.75);
  const parent = group[0]?.parentId ? byId[group[0].parentId] : undefined;
  const compact = parent?.bounds
    ? Math.max(...group.map((node) => (node.bounds?.y ?? 0) + (node.bounds?.height ?? 0))) - Math.min(...yValues) <= Math.max(32, parent.bounds.height * 1.5)
    : true;
  return sameRow && compact;
}

function collectDescendants(nodeId: string, nodes: Record<string, DesignNode>, output: DesignNode[] = []) {
  const node = nodes[nodeId];
  if (!node) return output;
  output.push(node);
  for (const childId of node.children) collectDescendants(childId, nodes, output);
  return output;
}

function isDescendantOf(nodeId: string, ancestorId: string | undefined, nodes: Record<string, DesignNode>) {
  if (!ancestorId) return true;
  let current: DesignNode | undefined = nodes[nodeId];
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.id)) {
    if (current.parentId === ancestorId) return true;
    visited.add(current.id);
    current = nodes[current.parentId];
  }
  return nodeId === ancestorId;
}

function findCommonAncestor(nodeIds: string[], nodes: Record<string, DesignNode>) {
  const paths = nodeIds.map((nodeId) => {
    const path: string[] = [];
    let current: DesignNode | undefined = nodes[nodeId];
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      path.push(current.id);
      visited.add(current.id);
      current = current.parentId ? nodes[current.parentId] : undefined;
    }
    return path;
  });
  return paths[0]?.find((candidate) => paths.every((path) => path.includes(candidate)));
}

async function persistedContexts(): Promise<DesignContext[]> {
  const state = await appState();
  return Array.isArray(state.contexts) ? state.contexts : [];
}

async function assetWithAvailability(asset: DesignAsset) {
  const confirmed = Boolean(asset.sourceUrl);
  const qualityIssues: string[] = [];
  if (!asset.sourceUrl) qualityIssues.push("missing-source-url");
  if (!asset.density || asset.downloadPolicy === "review" || asset.downloadStatus === "review") {
    qualityIssues.push("density-review");
  }
  if (asset.downloadStatus === "failed") qualityIssues.push("download-failed");
  if (!confirmed) {
    return { ...asset, availability: "candidate-only", confidence: "candidate", qualityIssues };
  }
  if (asset.downloadPolicy === "skip-density-variant" || asset.downloadStatus === "skipped") {
    return { ...asset, availability: "skipped", confidence: "confirmed", qualityIssues };
  }
  if (asset.localPath) {
    try {
      await access(asset.localPath);
      return { ...asset, availability: "available", confidence: "confirmed", qualityIssues };
    } catch {
      qualityIssues.push("local-file-missing");
      return { ...asset, availability: "remote-only", confidence: "confirmed", qualityIssues, availabilityReason: "localPath 不存在或当前进程无法读取，但 sourceUrl 可用" };
    }
  }
  return {
    ...asset,
    availability: "remote-only",
    confidence: "confirmed",
    qualityIssues,
    availabilityReason: asset.downloadPolicy === "review" || asset.downloadStatus === "review"
      ? "sourceUrl 可用；资源密度待复核，尚未写入本地缓存"
      : "sourceUrl 可用，尚未写入本地缓存"
  };
}

function documentSummary(document: DesignDocument) {
  return {
    id: document.id,
    provider: document.provider,
    title: document.title,
    sourceUrl: document.sourceUrl,
    preview: document.previewPath ? {
      uri: `lake://design-preview/${encodeURIComponent(document.id)}`,
      available: true,
      sourceUrl: document.previewUrl ?? null
    } : {
      uri: null,
      available: false,
      sourceUrl: document.previewUrl ?? null
    },
    syncedAt: document.syncedAt,
    syncVersion: document.syncVersion ?? 1,
    revisionCount: document.revisions?.length ?? 1,
    adapterVersion: document.adapterVersion,
    capabilityStatus: document.capabilityReport.status,
    capabilities: document.capabilityReport.capabilities,
    counts: {
      pages: document.pageIds.length,
      nodes: Object.keys(document.nodes).length,
      assets: Object.keys(document.assets).length,
      measurementCandidates: document.measurementCandidates?.length ?? 0
    }
  };
}

function envelope(document: DesignDocument, data: unknown) {
  return {
    source: {
      provider: document.provider,
      url: document.sourceUrl,
      syncedAt: document.syncedAt,
      syncVersion: document.syncVersion ?? 1,
      revisionCount: document.revisions?.length ?? 1,
      adapterVersion: document.adapterVersion,
      capabilityStatus: document.capabilityReport.status,
      pageIdentity: document.capabilityReport.pageIdentity ?? null
    },
    data
  };
}

function previewMimeType(path: string) {
  return /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.webp$/i.test(path) ? "image/webp" : "image/png";
}

async function previewResource(document: DesignDocument, uri: string) {
  if (!document.previewPath) throw new Error("当前设计稿没有已保存的官方预览图，请先同步当前页面");
  const bytes = await previewBytes(document);
  return {
    contents: [{
      uri,
      mimeType: previewMimeType(document.previewPath),
      blob: Buffer.from(bytes).toString("base64")
    }]
  };
}

async function previewBytes(document: DesignDocument) {
  if (!document.previewPath) throw new Error("当前设计稿没有已保存的官方预览图，请先同步当前页面");
  const readBinary = readFile as unknown as (path: string) => Promise<Uint8Array>;
  return readBinary(document.previewPath);
}

async function previewDocument(args: Record<string, unknown>) {
  const allDocuments = await documents();
  const state = await appState();
  const current = allDocuments.find((item) => item.id === state.currentDocumentId);
  return requireDocument(allDocuments, args.documentId ?? current?.id);
}

async function callTool(name: string, args: Record<string, unknown>) {
  const allDocuments = await documents();
  if (name === "list_design_documents") return { documents: allDocuments.map(documentSummary) };
  if (name === "get_design_preview") {
    const document = await previewDocument(args);
    return {
      documentId: document.id,
      title: document.title ?? null,
      uri: `lake://design-preview/${encodeURIComponent(document.id)}`,
      available: Boolean(document.previewPath),
      sourceUrl: document.previewUrl ?? null
    };
  }
  if (name === "get_current_selection") {
    const state = await appState();
    const storedDocument = allDocuments.find((item) => item.id === state.currentDocumentId);
    const document = storedDocument
      ?? [...allDocuments].sort((left, right) => Date.parse(right.syncedAt) - Date.parse(left.syncedAt))[0];
    if (!document) throw new Error("当前没有已同步的设计稿");
    const hasStoredDocument = Boolean(storedDocument);
    const hasStoredNodeId = hasStoredDocument && typeof state.currentNodeId === "string";
    const nodeId = hasStoredNodeId ? state.currentNodeId : undefined;
    const node = nodeId ? document.nodes[nodeId] : undefined;
    const selectionState = !hasStoredDocument
      ? "document-fallback"
      : node
        ? "selected"
        : hasStoredNodeId
          ? "stale-node"
          : "document-only";
    const maxDepth = boundedNumber(args.maxDepth, 8, 0, 64);
    const maxNodes = boundedNumber(args.maxNodes, 200, 1, 5_000);
    const selectedNodes: DesignNode[] = [];
    const truncation = { nodeLimit: false, depthLimit: false };
    const selectionTree = node
      ? implementationTreeNode(document.nodes, node.id, 0, maxDepth, maxNodes, selectedNodes, truncation)
      : null;
    return envelope(document, {
      kind: "current-selection",
      documentId: document.id,
      nodeId: node?.id ?? null,
      selectionState,
      document: documentSummary(document),
      node: node ? { ...node, confidence: node.sourceRef?.startsWith("lake-json:") ? "confirmed" : "candidate" } : null,
      selectionContext: node ? {
        nodes: selectionTree ? [selectionTree] : [],
        limits: { maxDepth, maxNodes },
        summary: { nodeCount: selectedNodes.length },
        truncation: {
          nodeLimit: truncation.nodeLimit,
          depthLimit: truncation.depthLimit,
          truncated: truncation.nodeLimit || truncation.depthLimit
        }
      } : null,
      note: selectionState === "selected"
        ? "这是桌面应用当前选中的节点。"
        : selectionState === "stale-node"
          ? "桌面应用保存的节点已不在当前设计稿中；已返回当前设计稿，但没有返回失效节点。"
          : selectionState === "document-fallback"
            ? "桌面应用保存的当前文档不存在；已回退到最近同步的设计稿，不能视为用户当前选择。"
            : "当前没有可恢复的选中节点，返回当前设计稿。"
    });
  }
  if (name === "get_current_implementation_context") {
    const state = await appState();
    const current = allDocuments.find((item) => item.id === state.currentDocumentId);
    const latest = [...allDocuments]
      .sort((left, right) => Date.parse(right.syncedAt) - Date.parse(left.syncedAt))[0];
    const document = current ?? latest;
    if (!document) throw new Error("当前没有已同步的设计稿");
    return callTool("get_implementation_context", {
      ...args,
      documentId: document.id
    });
  }
  if (name === "list_design_contexts") {
    const allContexts = await persistedContexts();
    return {
      contexts: [...allContexts, ...Array.from(contexts.values()).filter((context) => !allContexts.some((item) => item.id === context.id))].map((context) => ({
        ...context,
        nodeCount: context.nodeIds.length,
        documentTitle: allDocuments.find((document) => document.id === context.documentId)?.title,
        stale: isContextStale(context, allDocuments)
      }))
    };
  }

  if (name === "create_design_context") {
    const document = requireDocument(allDocuments, args.documentId);
    const nodeIds = asStringArray(args.nodeIds).filter((id) => Boolean(document.nodes[id]));
    const context: DesignContext = {
      id: `context:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      documentId: document.id,
      documentSyncedAt: document.syncedAt,
      nodeIds,
      createdAt: new Date().toISOString(),
      label: typeof args.label === "string" ? args.label : undefined
    };
    contexts.set(context.id, context);
    return envelope(document, context);
  }

  if (name === "get_design_context") {
    const context = (await persistedContexts()).find((item) => item.id === String(args.contextId)) ?? contexts.get(String(args.contextId));
    if (!context) throw new Error("未找到当前 MCP 进程中的 context");
    const document = requireDocument(allDocuments, context.documentId);
    const stale = isContextStale(context, allDocuments);
    const nodeSet = new Set(context.nodeIds);
    const maxDepth = boundedNumber(args.maxDepth, 64, 0, 128);
    const maxNodes = boundedNumber(args.maxNodes, Math.max(1, nodeSet.size), 1, 100_000);
    const roots = context.nodeIds.filter((id) => {
      const node = document.nodes[id];
      return Boolean(node && (!node.parentId || !nodeSet.has(node.parentId)));
    });
    const selectedNodes: DesignNode[] = [];
    const tree = roots.map((id) => contextTree(document.nodes, id, nodeSet, 0, maxDepth, maxNodes, selectedNodes)).filter(Boolean);
    const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
    const assets = await Promise.all(Object.values(document.assets)
      .filter((asset) => selectedNodes.some((node) => node.assetUrl && asset.sourceUrl === node.assetUrl))
      .map(assetWithAvailability));
    return envelope(document, {
      ...context,
      stale,
      pageStructure: document.pageStructure ?? null,
      limits: { maxDepth, maxNodes },
      truncated: selectedNodes.length < context.nodeIds.filter((id) => Boolean(document.nodes[id])).length,
      nodes: selectedNodes.map((node) => ({
        ...node,
        confidence: node.sourceRef?.startsWith("lake-json:") ? "confirmed" : "candidate",
        availability: node.sourceRef?.startsWith("lake-json:") ? "available" : "candidate-only"
      })),
      tree,
      assets,
      missingNodeIds: context.nodeIds.filter((id) => !document.nodes[id]),
      selectedNodeIds: Array.from(selectedNodeIds)
    });
  }

  if (name === "get_implementation_context") {
    const requestedContextId = typeof args.contextId === "string" ? args.contextId : undefined;
    const context = requestedContextId
      ? (await persistedContexts()).find((item) => item.id === requestedContextId) ?? contexts.get(requestedContextId)
      : undefined;
    if (requestedContextId && !context) throw new Error("未找到设计 context");
    const document = requireDocument(allDocuments, context?.documentId ?? args.documentId);
    const stale = context ? isContextStale(context, allDocuments) : false;
    const allowed = context ? new Set(context.nodeIds) : undefined;
    const availableNodeCount = allowed?.size ?? Object.keys(document.nodes).length;
    const maxDepth = boundedNumber(args.maxDepth, 64, 0, 128);
    const maxNodes = boundedNumber(args.maxNodes, Math.max(1, availableNodeCount), 1, 100_000);
    const roots = context
      ? context.nodeIds.filter((id) => {
          const node = document.nodes[id];
          return Boolean(node && (!node.parentId || !allowed?.has(node.parentId)));
        })
      : document.rootNodeIds;
    const selectedNodes: DesignNode[] = [];
    const truncation = { nodeLimit: false, depthLimit: false };
    const nodes = roots
      .map((id) => implementationTreeNode(document.nodes, id, 0, maxDepth, maxNodes, selectedNodes, truncation, allowed))
      .filter(Boolean);
    const selectedAssetCandidates = context
      ? Object.values(document.assets).filter((asset) => selectedNodes.some((node) => node.assetUrl && asset.sourceUrl === node.assetUrl))
      : Object.values(document.assets);
    const assets = await Promise.all(selectedAssetCandidates.map(assetWithAvailability));
    const platform = document.capabilityReport.diagnostics?.platformContext;
    const rootNode = document.rootNodeIds.map((id) => document.nodes[id]).find((node) => node?.bounds);
    const rootBounds = rootNode?.bounds;
    const viewportWidth = platform?.viewportWidth ?? rootBounds?.width ?? null;
    const contentHeight = platform?.contentHeight ?? rootBounds?.height ?? null;
    const derivedScrollable = viewportWidth !== null && contentHeight !== null ? contentHeight > viewportWidth : null;
    const usePlatformScrollability = platform?.confidence === "confirmed" || !rootBounds || derivedScrollable === null;
    const scrollable = usePlatformScrollability ? (platform?.scrollable ?? derivedScrollable) : derivedScrollable;
    const confirmedNodes = selectedNodes.filter((node) => node.sourceRef?.startsWith("lake-json:")).length;
    const candidateNodes = selectedNodes.length - confirmedNodes;
    return envelope(document, {
      kind: "implementation-context",
      mode: context ? "design-context" : "document",
      contextId: context?.id ?? null,
      contextLabel: context?.label ?? null,
      stale,
      pageStructure: document.pageStructure ?? null,
      status: document.capabilityReport.status === "ready" && candidateNodes === 0 ? "confirmed" : "partial",
      limits: { maxDepth, maxNodes },
      truncated: truncation.nodeLimit || truncation.depthLimit,
      truncation,
      target: {
        title: document.title ?? null,
        platform: platform?.kind ?? "unknown",
        designUnit: platform?.designUnit ?? "unknown",
        viewportWidth,
        contentHeight,
        scrollable,
        viewportSource: platform?.viewportWidth ? "platform-probe" : rootBounds ? "root-artboard" : "unavailable",
        contentHeightSource: platform?.contentHeight ? "platform-probe" : rootBounds ? "root-artboard" : "unavailable",
        scrollableSource: usePlatformScrollability && platform?.scrollable !== undefined && platform?.scrollable !== null ? "platform-probe" : rootBounds ? "derived-from-artboard" : "unavailable",
        artboardWidth: rootBounds?.width ?? null,
        artboardHeight: rootBounds?.height ?? null,
        confidence: platform?.confidence ?? (rootBounds ? "candidate" : "unknown")
      },
      visualReference: {
        uri: document.previewPath ? `lake://design-preview/${encodeURIComponent(document.id)}` : null,
        available: Boolean(document.previewPath),
        sourceUrl: document.previewUrl ?? null,
        guidance: document.previewPath
          ? "读取该 MCP 图片资源作为原始视觉参照，再结合 nodes、bounds、text 和 style 实现页面；不要把图片本身当作页面实现。"
          : "当前没有已保存的官方预览图，请先在桌面应用中同步当前页面。"
      },
      nodes,
      assets,
      summary: {
        nodeCount: selectedNodes.length,
        confirmedNodeCount: confirmedNodes,
        candidateNodeCount: candidateNodes,
        assetCount: assets.length,
        rootCount: roots.length
      },
      warnings: [
        ...(stale ? ["这个 context 来源的设计文档已经重新同步，请重新创建 context。"] : []),
        ...(candidateNodes > 0 ? [`${candidateNodes} 个节点不是来自已确认的设计 JSON，只能作为候选信息。`] : []),
        ...(assets.some((asset) => ["candidate-only", "missing", "review", "skipped"].includes(asset.availability)) ? ["部分资源需要人工处理；remote-only 资源可直接使用 sourceUrl，但尚未写入本地缓存。"] : []),
        ...(platform?.confidence !== "confirmed" ? ["平台单位和页面尺寸仍可能是候选值，生成代码时不要把它们当作绝对确认规格。"] : [])
        ,...(document.pageStructure?.confidence !== "confirmed" ? ["页面 header/Tab 结构未完全确认，不能仅根据画板名称猜测页面层级。"] : [])
      ],
      implementationGuidance: [
        "这是框架无关的设计输入，不生成或指定 React、Compose、SwiftUI、XML、UIKit 等实现技术；由调用方根据 target.platform 和用户指令选择目标框架。",
        "target.designUnit、viewportWidth、contentHeight 和 scrollable 必须结合各自的来源字段与 confidence 使用；candidate 或 derived 值需要在目标项目中复核。",
        "优先使用节点 bounds、text、style 和 children 还原布局，不要把整页预览图当作页面实现。",
        "将 sourceRef、confidence 和 availability 视为数据可信度边界；缺失或 candidate 字段需要人工确认。",
        "页面高度由节点边界和 contentHeight 决定，scrollable 为 true 时实现为可滚动页面。",
        "先读取 pageStructure 再实现页面导航：pageName/header 是页面语义，primaryTabs 是一级 Tab，secondaryTabs 是其下的二级 Tab；不要把某个画板 title 直接当成页面 header。",
        "pageStructure 中 selectedPrimaryTab/selectedSecondaryTab 是当前画板的选中状态候选，导航项本身仍必须全部保留。",
        "header 是独立的设计区域，必须按 header.bounds 和 header.elements 的 bounds 实现；header.elements 中的 required 元素都不能省略。",
        "header 元素的 role 只提供通用语义提示；unknown role 仍然必须依据 label、type、bounds 和 assetUrl 保留，不能因为无法分类而删除。",
        "资源没有 assetUrl 时仍要依据节点名称、类型和 bounds 保留视觉位置，并使用目标平台可用的图标或占位替代；不能因此删除头部。"
      ]
    });
  }

  const document = requireDocument(allDocuments, args.documentId);
  if (name === "get_design_document") return envelope(document, document);
  if (name === "get_design_specs") {
    const platform = document.capabilityReport.diagnostics?.platformContext;
    return envelope(document, {
      status: "candidate-only",
      pageStructure: document.pageStructure ?? null,
      platform: platform ? {
        label: platform.label,
        kind: platform.kind,
        designUnit: platform.designUnit,
        viewportWidth: platform.viewportWidth,
        contentHeight: platform.contentHeight,
        scrollable: platform.scrollable,
        confidence: platform.confidence,
        source: platform.source
      } : null,
      measurements: document.measurementCandidates ?? [],
      note: "这些值来自标注/规格面板的结构化数字提取；platform 是根据 Lake 右上角平台选择器得到的目标单位候选，尚未绑定字段语义，不能视为已确认设计规格。"
    });
  }
  if (name === "get_node") {
    const node = document.nodes[String(args.nodeId)];
    if (!node) throw new Error("未找到设计节点");
    return envelope(document, node);
  }
  if (name === "get_node_tree") {
    const maxDepth = boundedNumber(args.maxDepth, 64, 0, 128);
    return envelope(document, document.rootNodeIds.map((id) => treeNode(document.nodes, id, 0, maxDepth)).filter(Boolean));
  }
  if (name === "list_assets") return envelope(document, await Promise.all(Object.values(document.assets).map(assetWithAvailability)));
  if (name === "get_asset") {
    const asset = document.assets[String(args.assetId)];
    if (!asset) throw new Error("未找到设计资源");
    return envelope(document, await assetWithAvailability(asset));
  }
  throw new Error(`未知工具：${name}`);
}

function requireDocument(allDocuments: DesignDocument[], value: unknown) {
  const document = allDocuments.find((item) => item.id === String(value));
  if (!document) throw new Error("未找到设计文档");
  return document;
}

function isContextStale(context: DesignContext, allDocuments: DesignDocument[]) {
  if (!context.documentSyncedAt) return false;
  const document = allDocuments.find((item) => item.id === context.documentId);
  return Boolean(document && document.syncedAt !== context.documentSyncedAt);
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function contextTree(
  nodes: Record<string, DesignNode>,
  id: string,
  allowed: Set<string>,
  depth: number,
  maxDepth: number,
  maxNodes: number,
  selected: DesignNode[]
): unknown {
  if (selected.length >= maxNodes) return null;
  const node = nodes[id];
  if (!node || !allowed.has(id)) return null;
  selected.push(node);
  return {
    ...node,
    confidence: node.sourceRef?.startsWith("lake-json:") ? "confirmed" : "candidate",
    availability: node.sourceRef?.startsWith("lake-json:") ? "available" : "candidate-only",
    children: depth >= maxDepth
      ? []
      : node.children.map((child) => contextTree(nodes, child, allowed, depth + 1, maxDepth, maxNodes, selected)).filter(Boolean)
  };
}

function treeNode(nodes: Record<string, DesignNode>, id: string, depth: number, maxDepth: number): unknown {
  const node = nodes[id];
  if (!node) return null;
  return {
    ...node,
    children: depth >= maxDepth ? [] : node.children.map((child) => treeNode(nodes, child, depth + 1, maxDepth)).filter(Boolean)
  };
}

function implementationTreeNode(
  nodes: Record<string, DesignNode>,
  id: string,
  depth: number,
  maxDepth: number,
  maxNodes: number,
  selected: DesignNode[],
  truncation: { nodeLimit: boolean; depthLimit: boolean },
  allowed?: Set<string>
): unknown {
  if (selected.length >= maxNodes) {
    truncation.nodeLimit = true;
    return null;
  }
  if (allowed && !allowed.has(id)) return null;
  const node = nodes[id];
  if (!node) return null;
  selected.push(node);
  const confirmed = node.sourceRef?.startsWith("lake-json:") ?? false;
  const children = node.children.filter((child) => !allowed || allowed.has(child));
  if (depth >= maxDepth && children.length > 0) truncation.depthLimit = true;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    parentId: node.parentId ?? null,
    bounds: node.bounds ?? null,
    visible: node.visible ?? true,
    text: node.text ?? null,
    style: node.style ?? {},
    assetUrl: node.assetUrl ?? null,
    sourceRef: node.sourceRef ?? null,
    confidence: confirmed ? "confirmed" : "candidate",
    availability: confirmed ? "available" : "candidate-only",
    children: depth >= maxDepth
      ? []
      : children
        .map((child) => implementationTreeNode(nodes, child, depth + 1, maxDepth, maxNodes, selected, truncation, allowed))
        .filter(Boolean)
  };
}

function result(value: unknown, extraContent: unknown[] = []): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    result: {
      content: [
        { type: "text", text: JSON.stringify(value) },
        ...extraContent
      ]
    }
  };
}

const resourceIndexUri = "lake://design-documents";
const currentContextUri = "lake://implementation-context/current";
const currentSelectionUri = "lake://design-selection/current";

function documentResourceUri(documentId: string) {
  return `lake://design-document/${encodeURIComponent(documentId)}`;
}

function resourceForDocument(document: DesignDocument) {
  return {
    uri: documentResourceUri(document.id),
    name: document.title || document.id,
    description: "已同步设计稿的结构化节点、页面规格、资源和可信度信息。",
    mimeType: "application/json"
  };
}

async function resourcesList() {
  const allDocuments = await documents();
  const state = await appState();
  const current = allDocuments.find((item) => item.id === state.currentDocumentId);
  const latest = [...allDocuments].sort((left, right) => Date.parse(right.syncedAt) - Date.parse(left.syncedAt))[0];
  const selected = current ?? latest;
  return {
    resources: [
      {
        uri: currentContextUri,
        name: "当前设计稿实现上下文",
        description: selected
          ? `当前设计稿：${selected.title || selected.id}。适合 AI 读取并生成目标平台代码。`
          : "当前设计稿实现上下文。",
        mimeType: "application/json"
      },
      {
        uri: currentSelectionUri,
        name: "当前选中设计节点",
        description: "读取桌面应用当前选中的设计文档和节点。",
        mimeType: "application/json"
      },
      ...(selected?.previewPath ? [{
        uri: "lake://design-preview/current",
        name: "当前设计稿官方预览图",
        description: "当前设计稿的官方整页视觉预览图，供 AI 结合结构化节点数据进行视觉核对。",
        mimeType: previewMimeType(selected.previewPath)
      }] : []),
      {
        uri: resourceIndexUri,
        name: "已同步设计稿索引",
        description: "Lake Catch 中已同步的设计稿列表。",
        mimeType: "application/json"
      },
      ...allDocuments.map(resourceForDocument)
    ]
  };
}

function resourceTemplates() {
  return {
    resourceTemplates: [
      {
        uriTemplate: "lake://design-document/{documentId}",
        name: "设计稿实现上下文",
        description: "按设计稿 ID 读取结构化实现上下文。",
        mimeType: "application/json"
      },
      {
        uriTemplate: "lake://design-node/{documentId}/{nodeId}",
        name: "设计节点",
        description: "按设计稿 ID 和节点 ID 读取单个设计节点。",
        mimeType: "application/json"
      },
      {
        uriTemplate: "lake://design-preview/{documentId}",
        name: "设计稿官方预览图",
        description: "读取指定设计稿已保存的官方整页视觉预览图。",
        mimeType: "image/png"
      }
    ]
  };
}

async function readResource(uri: string) {
  const allDocuments = await documents();
  let value: unknown;
  if (uri === currentContextUri) {
    value = await callTool("get_current_implementation_context", {});
  } else if (uri === currentSelectionUri) {
    value = await callTool("get_current_selection", {});
  } else if (uri === resourceIndexUri) {
    value = { documents: allDocuments.map(documentSummary) };
  } else if (uri === "lake://design-preview/current") {
    const state = await appState();
    const current = allDocuments.find((item) => item.id === state.currentDocumentId);
    const selected = current ?? [...allDocuments].sort((left, right) => Date.parse(right.syncedAt) - Date.parse(left.syncedAt))[0];
    if (!selected) throw new Error("当前没有已同步的设计稿");
    return previewResource(selected, uri);
  } else if (uri.startsWith("lake://design-preview/")) {
    const documentId = decodeURIComponent(uri.slice("lake://design-preview/".length));
    const document = requireDocument(allDocuments, documentId);
    return previewResource(document, uri);
  } else if (uri.startsWith("lake://design-document/")) {
    const documentId = decodeURIComponent(uri.slice("lake://design-document/".length));
    const document = requireDocument(allDocuments, documentId);
    value = await callTool("get_implementation_context", { documentId });
  } else if (uri.startsWith("lake://design-node/")) {
    const parts = uri.slice("lake://design-node/".length).split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`无效的设计节点资源：${uri}`);
    const documentId = decodeURIComponent(parts[0]);
    const nodeId = decodeURIComponent(parts[1]);
    requireDocument(allDocuments, documentId);
    value = await callTool("get_node", { documentId, nodeId });
  } else {
    throw new Error(`未找到资源：${uri}`);
  }
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }]
  };
}

async function handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
          resources: { subscribe: false, listChanged: false }
        },
        serverInfo: { name: "lake-bridge", version: "0.1.0" }
      }
    };
  }
  if (request.method === "tools/list") return { jsonrpc: "2.0", id: request.id, result: { tools } };
  if (request.method === "resources/list") {
    return { jsonrpc: "2.0", id: request.id, result: await resourcesList() };
  }
  if (request.method === "resources/templates/list") {
    return { jsonrpc: "2.0", id: request.id, result: resourceTemplates() };
  }
  if (request.method === "resources/read") {
    try {
      const uri = String(request.params?.uri ?? "");
      return { jsonrpc: "2.0", id: request.id, result: await readResource(uri) };
    } catch (error) {
      return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : "读取资源失败" } };
    }
  }
  if (request.method === "tools/call") {
    const params = request.params ?? {};
    try {
      const name = String(params.name);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const value = await callTool(name, args);
      if (name === "get_design_preview") {
        const document = await previewDocument(args);
        const bytes = await previewBytes(document);
        return {
          ...result(value, [{
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: previewMimeType(document.previewPath ?? "")
          }]),
          id: request.id
        };
      }
      return { ...result(value), id: request.id };
    } catch (error) {
      return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : "工具调用失败" } };
    }
  }
  return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `未知方法：${request.method}` } };
}

let buffer = Buffer.alloc(0);

function writeResponse(response: JsonRpcResponse | null) {
  if (!response) return;
  const body = Buffer.from(JSON.stringify(response), "utf8");
  // MCP stdio transport is newline-delimited JSON. Keep stdout strictly to
  // one JSON-RPC message per line so Codex and other MCP clients can parse it.
  process.stdout.write(`${body.toString("utf8")}\n`);
}

function dispatch(raw: string) {
  try {
    void handle(JSON.parse(raw)).then(writeResponse);
  } catch (error) {
    writeResponse({
      jsonrpc: "2.0",
      error: { code: -32700, message: error instanceof Error ? error.message : "无效 JSON" }
    });
  }
}

function consumeFrames() {
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const headers = buffer.subarray(0, headerEnd).toString("ascii");
      const match = headers.match(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.byteLength < bodyStart + bodyLength) return;
      dispatch(buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8"));
      buffer = buffer.subarray(bodyStart + bodyLength);
      continue;
    }

    // Keep compatibility with the original newline-delimited smoke-test format.
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.subarray(0, newline).toString("utf8").trim();
    buffer = buffer.subarray(newline + 1);
    if (line) dispatch(line);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  consumeFrames();
});
