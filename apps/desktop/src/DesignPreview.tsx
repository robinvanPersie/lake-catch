import type { CSSProperties } from "react";
import type { PagePlatformContext } from "@lake/protocol";
import type { DesignDocument, DesignMeasurementCandidate } from "@lake/design-model";

interface DesignPreviewProps {
  document?: DesignDocument;
  platform?: PagePlatformContext;
  measurementCandidates?: DesignMeasurementCandidate[];
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
}

function platformLabel(platform?: PagePlatformContext) {
  if (!platform) return "未识别平台";
  if (platform.kind === "android") return "Android";
  if (platform.kind === "ios") return "iOS";
  if (platform.kind === "web") return "Web";
  return platform.label || "未知平台";
}

function unitLabel(platform?: PagePlatformContext) {
  return platform?.designUnit && platform.designUnit !== "unknown" ? platform.designUnit : "单位待确认";
}

export default function DesignPreview({ document, platform, measurementCandidates = [], selectedNodeId, onSelectNode }: DesignPreviewProps) {
  const title = document?.title || "待同步设计稿";
  const candidateCount = measurementCandidates.length;
  const layerNodes = Object.values(document?.nodes ?? {}).filter((node) => node.sourceRef?.startsWith("lake-json:"));
  const rootNode = document?.rootNodeIds.map((id) => document.nodes[id]).find((node) => node?.bounds);
  const rootBounds = rootNode?.bounds;
  // Prefer the current design's own artboard dimensions when the page platform
  // probe is unavailable. The fallback is only for a document with no usable
  // geometry at all, so desktop/tablet designs are not forced into 375 px.
  const designWidth = platform?.viewportWidth ?? rootBounds?.width ?? 375;
  const targetHeight = platform?.contentHeight ?? rootBounds?.height;
  const isScrollable = platform?.scrollable ?? (rootBounds ? rootBounds.height > designWidth : undefined);
  const nodesWithBounds = layerNodes.filter((node) => node.bounds && node.bounds.width > 0 && node.bounds.height > 0);
  const normalizedBounds = (node: (typeof layerNodes)[number]) => {
    if (!node.bounds) return undefined;
    // The API returns the root artboard in page coordinates while descendants use artboard-local coordinates.
    if (node.id === rootNode?.id) return { ...node.bounds, x: 0, y: 0 };
    return node.bounds;
  };
  const maxLayerRight = nodesWithBounds.reduce((max, node) => {
    const bounds = normalizedBounds(node);
    return Math.max(max, (bounds?.x ?? 0) + (bounds?.width ?? 0));
  }, 0);
  const coordinateWidth = Math.max(designWidth, maxLayerRight);
  const renderScale = coordinateWidth > designWidth * 1.15 ? designWidth / coordinateWidth : 1;
  const maxLayerBottom = nodesWithBounds.reduce((max, node) => {
    const bounds = normalizedBounds(node);
    return Math.max(max, ((bounds?.y ?? 0) + (bounds?.height ?? 0)) * renderScale);
  }, 0);
  const artboardHeight = rootBounds?.height ?? 0;
  const previewHeight = Math.max(
    Math.min((targetHeight ?? artboardHeight) * renderScale, artboardHeight ? artboardHeight * renderScale : Number.POSITIVE_INFINITY),
    Math.min(maxLayerBottom, artboardHeight ? artboardHeight * renderScale : maxLayerBottom),
    620
  );
  const hasRealLayers = layerNodes.length > 0;
  const visibleLayers = layerNodes;
  const imageLayers = layerNodes.filter((node) => node.type.toLowerCase().includes("image") || node.type.toLowerCase().includes("bitmap") || node.type.toLowerCase().includes("photo"));
  const imageLayersWithUrl = imageLayers.filter((node) => Boolean(node.assetUrl)).length;

  const layerKind = (node: (typeof layerNodes)[number]) => {
    const type = node.type.toLowerCase();
    if (node.text || type.includes("text")) return "text";
    if (type.includes("image") || type.includes("bitmap") || type.includes("photo")) return "image";
    return "shape";
  };

  const layerStyle = (node: (typeof layerNodes)[number], scale: number): CSSProperties => {
    const style = node.style ?? {};
    const css: CSSProperties = {};
    if (typeof style.opacity === "number") css.opacity = style.opacity > 1 ? style.opacity / 100 : style.opacity;
    if (typeof style.rotation === "number") css.transform = `rotate(${style.rotation}deg)`;
    if (typeof style.backgroundColor === "string") css.backgroundColor = style.backgroundColor;
    if (typeof style.color === "string") css.color = style.color;
    if (typeof style.borderColor === "string") css.borderColor = style.borderColor;
    if (typeof style.borderWidth === "number") css.borderWidth = `${style.borderWidth * scale}px`;
    if (typeof style.borderRadius === "number") css.borderRadius = `${style.borderRadius * scale}px`;
    if (typeof style.fontSize === "number") css.fontSize = `${style.fontSize * scale}px`;
    if (typeof style.fontWeight === "number" || typeof style.fontWeight === "string") css.fontWeight = style.fontWeight as CSSProperties["fontWeight"];
    if (typeof style.lineHeight === "number") css.lineHeight = `${style.lineHeight * scale}px`;
    if (typeof style.letterSpacing === "number") css.letterSpacing = `${style.letterSpacing * scale}px`;
    if (typeof style.fontFamily === "string") css.fontFamily = style.fontFamily;
    if (typeof style.textAlign === "string") css.textAlign = style.textAlign as CSSProperties["textAlign"];
    return css;
  };

  return (
    <div className="preview-shell">
      <div className="preview-toolbar">
        <div>
          <p className="preview-kicker">候选规格预览</p>
          <h3>{title}</h3>
        </div>
        <div className="preview-meta">
          <span>{platformLabel(platform)}</span>
          <span>{designWidth}{unitLabel(platform)}</span>
          {targetHeight ? <span>{targetHeight}{unitLabel(platform)} · {isScrollable === false ? "固定页面" : "可滚动"}</span> : <span>高度自然撑开</span>}
        </div>
      </div>

      <div className={`preview-notice ${hasRealLayers ? "preview-notice-real" : ""}`}>
        {hasRealLayers
          ? `当前预览使用本次同步的真实设计图层：${layerNodes.length} 个图层；图片图层 ${imageLayers.length} 个，其中 ${imageLayersWithUrl} 个已有资源 URL。`
          : "当前还没有可用的设计图层。这里仅展示平台宽度和滚动模型，不代表真实视觉稿还原。"}
      </div>

      <div className="preview-stage">
        <div className={`preview-device ${hasRealLayers ? "preview-device-real" : ""}`} style={{ width: `${designWidth}px`, minHeight: `${previewHeight}px` }}>
          {hasRealLayers ? (
            <div className="design-layer-canvas" style={{ width: `${designWidth}px`, minHeight: `${previewHeight}px` }}>
              {visibleLayers.map((node, index) => {
                const bounds = normalizedBounds(node);
                const kind = layerKind(node);
                const style = bounds ? {
                  left: `${bounds.x * renderScale}px`,
                  top: `${bounds.y * renderScale}px`,
                  width: `${Math.max(bounds.width * renderScale, 1)}px`,
                  height: `${Math.max(bounds.height * renderScale, 1)}px`,
                  zIndex: index + 1
                } : { zIndex: index + 1 };
                const assetUrl = node.assetUrl;
                return (
                  <div
                    className={`design-layer design-layer-${kind} ${bounds ? "has-bounds" : "no-bounds"} ${selectedNodeId === node.id ? "selected" : ""}`}
                    key={node.id}
                    style={{ ...style, ...layerStyle(node, renderScale) }}
                    title={`${node.name} · ${node.type}`}
                    role="button"
                    tabIndex={bounds ? 0 : -1}
                    aria-label={`选择图层 ${node.name}`}
                    onClick={() => onSelectNode?.(node.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectNode?.(node.id);
                      }
                    }}
                  >
                    {kind === "text" ? (node.text || node.name) : kind === "image" && assetUrl ? <img src={assetUrl} alt={node.name} loading="lazy" /> : kind === "image" ? "图片资源候选" : !bounds ? node.name : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <main className="preview-page">
              <p className="preview-category">尚未获取设计图层</p>
              <h1>等待真实设计数据</h1>
              <p>请在 Lake 页面保持当前设计稿打开，再次点击“同步当前页面”。</p>
            </main>
          )}
        </div>
        {targetHeight && (
          <div className="preview-ruler" aria-label={`候选内容高度 ${targetHeight}${unitLabel(platform)}`}>
            <span>候选内容高度 {targetHeight}{unitLabel(platform)}</span>
          </div>
        )}
      </div>

      <footer className="preview-footer">
        <span>规格状态：候选</span>
        <span>{candidateCount} 个候选测量值</span>
        <span>来源：页面平台选择器</span>
      </footer>
    </div>
  );
}
