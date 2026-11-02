import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type { PagePlatformContext } from "@lake/protocol";
import type { DesignDocument, DesignMeasurementCandidate, DesignNode } from "@lake/design-model";

interface DesignPreviewProps {
  document?: DesignDocument;
  platform?: PagePlatformContext;
  measurementCandidates?: DesignMeasurementCandidate[];
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
}

function unitLabel(platform?: PagePlatformContext) {
  return platform?.designUnit && platform.designUnit !== "unknown" ? platform.designUnit : "单位待确认";
}

function nodePaintOrder(document: DesignDocument | undefined, nodes: DesignNode[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const originalIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const order = new Map<string, { depth: number; path: number[]; index: number }>();
  const visited = new Set<string>();

  const visit = (nodeId: string, depth: number, path: number[]) => {
    const node = nodeById.get(nodeId);
    if (!node || visited.has(nodeId)) return;
    visited.add(nodeId);
    order.set(nodeId, { depth, path, index: originalIndex.get(nodeId) ?? 0 });
    node.children.forEach((childId, index) => visit(childId, depth + 1, [...path, index]));
  };

  (document?.rootNodeIds ?? []).forEach((nodeId, index) => visit(nodeId, 0, [index]));
  nodes.filter((node) => !visited.has(node.id) && (!node.parentId || !nodeById.has(node.parentId)))
    .forEach((node, index) => visit(node.id, 0, [Number.MAX_SAFE_INTEGER, index]));
  nodes.forEach((node, index) => {
    if (!order.has(node.id)) order.set(node.id, { depth: 0, path: [Number.MAX_SAFE_INTEGER, index], index });
  });
  return order;
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function colorValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.color === "string") return item.color;
  const red = asNumber(item.r ?? item.red);
  const green = asNumber(item.g ?? item.green);
  const blue = asNumber(item.b ?? item.blue);
  if (red === undefined || green === undefined || blue === undefined) return undefined;
  const alpha = asNumber(item.a ?? item.alpha);
  const channel = (channelValue: number) => Math.round(channelValue <= 1 ? channelValue * 255 : channelValue);
  return alpha === undefined ? `rgb(${channel(red)}, ${channel(green)}, ${channel(blue)})` : `rgba(${channel(red)}, ${channel(green)}, ${channel(blue)}, ${alpha <= 1 ? alpha : alpha / 100})`;
}

function firstColor(value: unknown): string | undefined {
  const direct = colorValue(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const color = firstColor(item);
      if (color) return color;
    }
  }
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    for (const key of ["color", "backgroundColor", "fillColor", "fills", "fill", "paint", "paints"]) {
      const color = firstColor(item[key]);
      if (color) return color;
    }
  }
  return undefined;
}

function gradientValue(value: unknown): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const paint = item as Record<string, unknown>;
    const gradient = paint.gradient && typeof paint.gradient === "object" ? paint.gradient as Record<string, unknown> : paint;
    const type = String(paint.type ?? paint.kind ?? gradient.type ?? gradient.kind ?? "").toLowerCase();
    if (!type.includes("gradient")) continue;
    const stops = gradient.stops ?? gradient.gradientStops ?? gradient.colorStops;
    if (!Array.isArray(stops) || stops.length < 2) continue;
    const colors = stops
      .map((stop) => {
        if (!stop || typeof stop !== "object") return undefined;
        const entry = stop as Record<string, unknown>;
        const color = colorValue(entry.color ?? entry.value ?? entry.paint);
        if (!color) return undefined;
        const position = asNumber(entry.position ?? entry.offset ?? entry.location);
        return position === undefined ? color : `${color} ${Math.round(position <= 1 ? position * 100 : position)}%`;
      })
      .filter((stop): stop is string => Boolean(stop));
    if (colors.length >= 2) {
      const angle = asNumber(paint.angle ?? paint.rotation ?? gradient.angle ?? gradient.rotation);
      return `linear-gradient(${angle ?? 180}deg, ${colors.join(", ")})`;
    }
  }
  return undefined;
}

function shadowValue(value: unknown): string | undefined {
  const shadows = Array.isArray(value) ? value : [value];
  const cssShadows = shadows.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const shadow = item as Record<string, unknown>;
    const color = colorValue(shadow.color ?? shadow.shadowColor) ?? "rgba(0, 0, 0, 0.18)";
    const x = asNumber(shadow.offsetX ?? shadow.x ?? shadow.dx) ?? 0;
    const y = asNumber(shadow.offsetY ?? shadow.y ?? shadow.dy) ?? 0;
    const blur = asNumber(shadow.blur ?? shadow.blurRadius) ?? 0;
    const spread = asNumber(shadow.spread ?? shadow.spreadRadius) ?? 0;
    const inset = shadow.inset === true ? "inset " : "";
    return `${inset}${x}px ${y}px ${blur}px ${spread}px ${color}`;
  });
  return cssShadows.length > 0 ? cssShadows.join(", ") : undefined;
}

export default function DesignPreview({ document, platform, measurementCandidates = [], selectedNodeId, onSelectNode }: DesignPreviewProps) {
  const [zoom, setZoom] = useState(1);
  const [officialPreviewFailed, setOfficialPreviewFailed] = useState(false);
  const [hitCandidates, setHitCandidates] = useState<string[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  const [lastHitPoint, setLastHitPoint] = useState<{ x: number; y: number }>();
  const title = document?.title || "待同步设计稿";
  const selectedNode = selectedNodeId && document?.nodes[selectedNodeId];
  const candidateCount = measurementCandidates.length;
  const layerNodes = Object.values(document?.nodes ?? {}).filter((node) => node.sourceRef?.startsWith("lake-json:"));
  const rootNode = document?.rootNodeIds.map((id) => document.nodes[id]).find((node) => node?.bounds);
  const rootBounds = rootNode?.bounds;
  // In the desktop app, a remote preview URL is only metadata. The native
  // sync step must first cache it locally; otherwise hiding the real layers
  // here would turn a failed image request into a blank canvas.
  const previewSource = isTauri()
    ? document?.previewPath ? convertFileSrc(document.previewPath) : undefined
    : document?.previewUrl;
  const hasOfficialPreview = Boolean(previewSource) && !officialPreviewFailed;
  // Prefer the current design's own artboard dimensions when the page platform
  // probe is unavailable. The fallback is only for a document with no usable
  // geometry at all, so desktop/tablet designs are not forced into 375 px.
  const designWidth = hasOfficialPreview
    ? rootBounds?.width ?? platform?.viewportWidth ?? 375
    : platform?.viewportWidth ?? rootBounds?.width ?? 375;
  const targetHeight = hasOfficialPreview
    ? rootBounds?.height
    : platform?.contentHeight ?? rootBounds?.height;
  const nodesWithBounds = layerNodes.filter((node) => node.bounds && node.bounds.width > 0 && node.bounds.height > 0);
  const normalizedBounds = (node: DesignNode) => {
    if (!node.bounds) return undefined;
    // The API returns the root artboard in page coordinates while descendants use artboard-local coordinates.
    if (node.id === rootNode?.id) return { ...node.bounds, x: 0, y: 0 };
    return node.bounds;
  };
  const maxLayerRight = nodesWithBounds.reduce((max, node) => {
    const bounds = normalizedBounds(node);
    return Math.max(max, (bounds?.x ?? 0) + (bounds?.width ?? 0));
  }, 0);
  const coordinateWidth = hasOfficialPreview ? designWidth : Math.max(designWidth, maxLayerRight);
  const renderScale = coordinateWidth > designWidth * 1.15 ? designWidth / coordinateWidth : 1;
  const effectiveScale = renderScale * zoom;
  const maxLayerBottom = nodesWithBounds.reduce((max, node) => {
    const bounds = normalizedBounds(node);
    return Math.max(max, ((bounds?.y ?? 0) + (bounds?.height ?? 0)) * effectiveScale);
  }, 0);
  const artboardHeight = rootBounds?.height ?? 0;
  const previewHeight = hasOfficialPreview
    ? Math.max(artboardHeight * effectiveScale, 1)
    : Math.max(
      Math.min((targetHeight ?? artboardHeight) * effectiveScale, artboardHeight ? artboardHeight * effectiveScale : Number.POSITIVE_INFINITY),
      Math.min(maxLayerBottom, artboardHeight ? artboardHeight * effectiveScale : maxLayerBottom),
      620 * zoom
    );
  const hasRealLayers = layerNodes.length > 0;
  const paintOrder = nodePaintOrder(document, layerNodes);
  const visibleLayers = layerNodes
    .filter((node) => node.visible !== false)
    .sort((left, right) => {
      const a = paintOrder.get(left.id);
      const b = paintOrder.get(right.id);
      if (!a || !b) return 0;
      const length = Math.max(a.path.length, b.path.length);
      for (let index = 0; index < length; index += 1) {
        const leftValue = a.path[index] ?? -1;
        const rightValue = b.path[index] ?? -1;
        if (leftValue !== rightValue) return leftValue - rightValue;
      }
      return a.depth - b.depth;
    });
  const imageLayers = layerNodes.filter((node) => node.type.toLowerCase().includes("image") || node.type.toLowerCase().includes("bitmap") || node.type.toLowerCase().includes("photo"));
  const imageLayersWithUrl = imageLayers.filter((node) => Boolean(node.assetUrl)).length;
  const previewLayers = hasOfficialPreview ? visibleLayers.filter((node) => Boolean(normalizedBounds(node))) : visibleLayers;

  useEffect(() => {
    setZoom(1);
    setOfficialPreviewFailed(false);
    setHitCandidates([]);
    setHitIndex(0);
    setLastHitPoint(undefined);
  }, [document?.id, document?.syncedAt]);

  const layerKind = (node: (typeof layerNodes)[number]) => {
    const type = node.type.toLowerCase();
    if (node.text || type.includes("text")) return "text";
    if (type.includes("image") || type.includes("bitmap") || type.includes("photo")) return "image";
    return "shape";
  };

  const layerStyle = (node: (typeof layerNodes)[number], scale: number): CSSProperties => {
    const style = node.style ?? {};
    const css: CSSProperties = {};
    const opacity = asNumber(style.opacity);
    const rotation = asNumber(style.rotation);
    const borderWidth = asNumber(style.borderWidth);
    const borderRadius = asNumber(style.borderRadius);
    const fontSize = asNumber(style.fontSize);
    const lineHeight = asNumber(style.lineHeight);
    const letterSpacing = asNumber(style.letterSpacing);
    const isText = Boolean(node.text) || node.type.toLowerCase().includes("text");
    const fills = style.fill ?? style.fills;
    const borders = style.border ?? style.borders ?? style.stroke ?? style.strokes;
    const background = isText
      ? firstColor(style.backgroundColor ?? style.bgColor ?? style.background ?? style.backgrounds)
      : firstColor(style.backgroundColor ?? style.bgColor ?? fills ?? style.background ?? style.backgrounds);
    const gradient = isText ? undefined : gradientValue(fills ?? style.background ?? style.backgrounds ?? style.gradient ?? style.gradients);
    const foreground = firstColor(style.color ?? style.textColor ?? style.fillColor ?? (isText ? fills : undefined));
    const border = firstColor(style.borderColor ?? style.strokeColor ?? borders);
    const computedBorderWidth = borderWidth ?? (Array.isArray(borders)
      ? asNumber((borders[0] as Record<string, unknown> | undefined)?.width)
      : undefined);
    const shadow = shadowValue(style.shadow ?? style.shadows ?? style.effect ?? style.effects);
    if (opacity !== undefined) css.opacity = opacity > 1 ? opacity / 100 : opacity;
    if (rotation !== undefined && rotation !== 0) css.transform = `rotate(${rotation}deg)`;
    if (background) css.backgroundColor = background;
    if (gradient) css.backgroundImage = gradient;
    if (foreground) css.color = foreground;
    if (border) css.borderColor = border;
    if (computedBorderWidth !== undefined) css.borderWidth = `${computedBorderWidth * scale}px`;
    if (borderRadius !== undefined) css.borderRadius = `${borderRadius * scale}px`;
    if (shadow) css.boxShadow = shadow;
    if (fontSize !== undefined) css.fontSize = `${fontSize * scale}px`;
    const fontWeight = style.fontWeight;
    if (typeof fontWeight === "number" || typeof fontWeight === "string") css.fontWeight = fontWeight as CSSProperties["fontWeight"];
    if (lineHeight !== undefined) css.lineHeight = `${lineHeight * scale}px`;
    if (letterSpacing !== undefined) css.letterSpacing = `${letterSpacing * scale}px`;
    const fontFamily = style.fontFamily;
    if (typeof fontFamily === "string") css.fontFamily = fontFamily;
    const textAlign = style.textAlign;
    if (typeof textAlign === "string") css.textAlign = textAlign.toLowerCase() as CSSProperties["textAlign"];
    const textVerticalAlign = style.textVerticalAlign;
    if (typeof textVerticalAlign === "string") css.display = "flex";
    if (typeof textVerticalAlign === "string") css.alignItems = textVerticalAlign.toLowerCase() === "bottom" ? "flex-end" : textVerticalAlign.toLowerCase() === "center" ? "center" : "flex-start";
    const fontStyle = style.fontStyle;
    if (typeof fontStyle === "string" && /italic/i.test(fontStyle)) css.fontStyle = "italic";
    if (typeof style.objectFit === "string") css.objectFit = style.objectFit as CSSProperties["objectFit"];
    return css;
  };

  const assetUrlForNode = (node: (typeof layerNodes)[number]) => {
    const asset = Object.values(document?.assets ?? {}).find((item) => item.sourceUrl && item.sourceUrl === node.assetUrl);
    if (asset?.localPath && isTauri()) return convertFileSrc(asset.localPath);
    return node.assetUrl;
  };

  const handleCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const point = {
      x: (event.clientX - rect.left) / effectiveScale,
      y: (event.clientY - rect.top) / effectiveScale
    };
    const samePoint = lastHitPoint && Math.abs(lastHitPoint.x - point.x) < 2 && Math.abs(lastHitPoint.y - point.y) < 2;
    const paintOrder = nodePaintOrder(document, layerNodes);
    const candidates = layerNodes
      .map((node, index) => ({ node, index, bounds: normalizedBounds(node) }))
      .filter(({ node, bounds }) => node.visible !== false && bounds && point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height)
      .sort((a, b) => {
        const left = paintOrder.get(a.node.id) ?? { depth: 0, path: [], index: a.index };
        const right = paintOrder.get(b.node.id) ?? { depth: 0, path: [], index: b.index };
        if (left.depth !== right.depth) return right.depth - left.depth;
        const pathLength = Math.max(left.path.length, right.path.length);
        for (let index = 0; index < pathLength; index += 1) {
          const leftValue = left.path[index] ?? -1;
          const rightValue = right.path[index] ?? -1;
          if (leftValue !== rightValue) return rightValue - leftValue;
        }
        return right.index - left.index;
      })
      .map(({ node }) => node.id);
    if (candidates.length === 0) {
      setHitCandidates([]);
      setHitIndex(0);
      setLastHitPoint(point);
      return;
    }
    const nextCandidates = samePoint && hitCandidates.length > 0 ? hitCandidates : candidates;
    const nextIndex = samePoint && hitCandidates.length > 0 ? (hitIndex + 1) % nextCandidates.length : 0;
    setHitCandidates(nextCandidates);
    setHitIndex(nextIndex);
    setLastHitPoint(point);
    onSelectNode?.(nextCandidates[nextIndex]);
  };

  return (
    <div className="preview-shell">
      <div className="preview-toolbar">
        <div>
          <p className="preview-kicker">候选规格预览</p>
          <h3>{title}</h3>
          <div className={`preview-selection ${selectedNode ? "is-selected" : ""}`} aria-live="polite">
            <span className="preview-selection-dot" aria-hidden="true" />
            {selectedNode ? (
              <>
                <strong>已选图层：{selectedNode.name || "未命名图层"}</strong>
                <span>{selectedNode.type} · {selectedNode.bounds ? `${Math.round(selectedNode.bounds.width)} × ${Math.round(selectedNode.bounds.height)}` : "无边界"}</span>
              </>
            ) : <span>尚未选中图层</span>}
          </div>
        </div>
        <div className="preview-controls" aria-label="画布缩放">
          <button type="button" className="icon-button" onClick={() => setZoom((value) => Math.max(0.25, Math.round((value - 0.25) * 100) / 100))} aria-label="缩小画布" title="缩小">−</button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button type="button" className="icon-button" onClick={() => setZoom((value) => Math.min(4, Math.round((value + 0.25) * 100) / 100))} aria-label="放大画布" title="放大">+</button>
          <button type="button" className="small-button" onClick={() => setZoom(1 / renderScale)}>原始比例</button>
          <button type="button" className="small-button" onClick={() => setZoom(1)}>适配宽度</button>
        </div>
      </div>

      <div className={`preview-notice ${hasRealLayers ? "preview-notice-real" : ""}`}>
        {hasRealLayers
          ? hasOfficialPreview
            ? `当前预览使用官方设计渲染图；${layerNodes.length} 个图层数据用于点击选择和节点详情。`
            : `当前预览使用本次同步的真实设计图层：${layerNodes.length} 个图层；图片图层 ${imageLayers.length} 个，其中 ${imageLayersWithUrl} 个已有资源 URL。`
          : "当前还没有可用的设计图层。这里仅展示平台宽度和滚动模型，不代表真实视觉稿还原。"}
      </div>

      <div className="preview-stage">
        <div className={`preview-device ${hasRealLayers ? "preview-device-real" : ""}`} style={{ width: `${coordinateWidth * effectiveScale}px`, ...(hasOfficialPreview ? { height: `${previewHeight}px` } : { minHeight: `${previewHeight}px` }) }}>
          {hasRealLayers ? (
            <div className="design-layer-canvas" style={{ width: `${coordinateWidth * effectiveScale}px`, height: `${previewHeight}px` }} onClick={handleCanvasClick} role="application" aria-label="设计画布">
              {hasOfficialPreview && previewSource && (
                <img
                  className="design-official-preview"
                  src={previewSource}
                  alt={`${title} 官方设计预览`}
                  draggable={false}
                  onError={() => setOfficialPreviewFailed(true)}
                />
              )}
              {previewLayers.map((node, index) => {
                const bounds = normalizedBounds(node);
                const kind = layerKind(node);
                const style = bounds ? {
                  left: `${bounds.x * effectiveScale}px`,
                  top: `${bounds.y * effectiveScale}px`,
                  width: `${Math.max(bounds.width * effectiveScale, 1)}px`,
                  height: `${Math.max(bounds.height * effectiveScale, 1)}px`,
                  zIndex: index + 1
                } : { zIndex: index + 1 };
                const assetUrl = hasOfficialPreview ? undefined : assetUrlForNode(node);
                const visualStyle = hasOfficialPreview
                  ? { background: "transparent", backgroundImage: "none", border: 0, boxShadow: "none", color: "transparent" }
                  : layerStyle(node, effectiveScale);
                return (
                  <div
                    className={`design-layer design-layer-${kind} ${bounds ? "has-bounds" : "no-bounds"} ${selectedNodeId === node.id ? "selected" : ""}`}
                    key={node.id}
                    title={`${node.name} · ${node.type}`}
                    aria-hidden="true"
                    style={{ ...style, ...visualStyle, pointerEvents: "none" }}
                  >
                    {!hasOfficialPreview && (kind === "text" ? (node.text || node.name) : kind === "image" && assetUrl ? <img src={assetUrl} alt={node.name} loading="lazy" /> : kind === "image" ? "图片资源候选" : !bounds ? node.name : null)}
                  </div>
                );
              })}
              {selectedNode && normalizedBounds(selectedNode) && (() => {
                const bounds = normalizedBounds(selectedNode);
                if (!bounds) return null;
                return (
                  <div
                    className="design-layer-selection-overlay"
                    aria-hidden="true"
                    style={{
                      left: `${bounds.x * effectiveScale}px`,
                      top: `${bounds.y * effectiveScale}px`,
                      width: `${Math.max(bounds.width * effectiveScale, 1)}px`,
                      height: `${Math.max(bounds.height * effectiveScale, 1)}px`
                    }}
                  />
                );
              })()}
            </div>
          ) : (
            <main className="preview-page">
              <p className="preview-category">尚未获取设计图层</p>
              <h1>等待真实设计数据</h1>
              <p>请在 Lake 页面保持当前设计稿打开，再次点击“同步当前页面”。</p>
            </main>
          )}
          {hitCandidates.length > 1 && (
            <div className="canvas-hit-status" aria-live="polite">
              重叠图层 {hitIndex + 1}/{hitCandidates.length} · 再点击同一位置切换
            </div>
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
