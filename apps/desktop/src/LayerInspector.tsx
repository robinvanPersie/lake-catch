import { useMemo, useState } from "react";
import type { DesignDocument, DesignNode } from "@lake/design-model";

interface LayerInspectorProps {
  document?: DesignDocument;
  selectedNodeId?: string;
  onSelect: (nodeId: string) => void;
}

function kindLabel(node: DesignNode) {
  const type = node.type.toLowerCase();
  if (node.text || type.includes("text")) return "文字";
  if (type.includes("image") || type.includes("bitmap") || type.includes("photo")) return "图片";
  if (type.includes("artboard") || type.includes("frame") || type.includes("group")) return "容器";
  return "图层";
}

function boundsLabel(node: DesignNode) {
  if (!node.bounds) return "无边界";
  const { x, y, width, height } = node.bounds;
  return `${Math.round(x)}, ${Math.round(y)} · ${Math.round(width)} × ${Math.round(height)}`;
}

function TreeNode({
  node,
  nodes,
  depth,
  selectedNodeId,
  onSelect
}: {
  node: DesignNode;
  nodes: Record<string, DesignNode>;
  depth: number;
  selectedNodeId?: string;
  onSelect: (nodeId: string) => void;
}) {
  const childNodes = node.children.map((id) => nodes[id]).filter(Boolean);
  const [expanded, setExpanded] = useState(depth < 1);
  const selected = selectedNodeId === node.id;
  return (
    <div className="layer-tree-node">
      <div className={`layer-tree-row ${selected ? "selected" : ""}`} style={{ paddingLeft: `${8 + depth * 14}px` }}>
        {childNodes.length > 0 ? (
          <button className="layer-tree-toggle" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? "收起图层" : "展开图层"}>
            {expanded ? "⌄" : "›"}
          </button>
        ) : <span className="layer-tree-toggle-spacer" />}
        <button className="layer-tree-select" onClick={() => onSelect(node.id)} title={`${node.name} · ${node.type}`}>
          <span className="layer-tree-kind">{kindLabel(node)}</span>
          <span className="layer-tree-name">{node.name || "未命名图层"}</span>
          {!node.visible && <span className="layer-tree-hidden">隐藏</span>}
        </button>
      </div>
      {expanded && childNodes.map((child) => (
        <TreeNode key={child.id} node={child} nodes={nodes} depth={depth + 1} selectedNodeId={selectedNodeId} onSelect={onSelect} />
      ))}
    </div>
  );
}

export default function LayerInspector({ document, selectedNodeId, onSelect }: LayerInspectorProps) {
  const nodes = document?.nodes ?? {};
  const lakeNodes = useMemo(() => Object.values(nodes).filter((node) => node.sourceRef?.startsWith("lake-json:")), [nodes]);
  const roots = useMemo(() => {
    const rootIds = document?.rootNodeIds ?? [];
    return rootIds.map((id) => nodes[id]).filter((node): node is DesignNode => Boolean(node && node.sourceRef?.startsWith("lake-json:")));
  }, [document?.rootNodeIds, nodes]);
  const selectedNode = selectedNodeId ? nodes[selectedNodeId] : undefined;
  const styles = selectedNode?.style ? Object.entries(selectedNode.style) : [];

  if (!document || lakeNodes.length === 0) {
    return (
      <section className="layer-inspector empty-layer-inspector">
        <div className="section-heading"><h3>图层检查器</h3><span>暂无数据</span></div>
        <p className="document-note">同步设计 JSON 后，这里会显示真实图层树和节点详情。</p>
      </section>
    );
  }

  return (
    <section className="layer-inspector" aria-label="图层检查器">
      <div className="section-heading">
        <h3>图层检查器</h3>
        <span>{lakeNodes.length} 个真实图层</span>
      </div>
      <div className="layer-inspector-grid">
        <div className="layer-tree" role="tree" aria-label="真实设计图层">
          {roots.map((node) => <TreeNode key={node.id} node={node} nodes={nodes} depth={0} selectedNodeId={selectedNodeId} onSelect={onSelect} />)}
          {roots.length === 0 && <p className="document-note">当前图层没有可识别的根节点。</p>}
        </div>
        <div className="layer-details">
          {selectedNode ? (
            <>
              <div className="layer-detail-title">
                <strong>{selectedNode.name || "未命名图层"}</strong>
                <span>{kindLabel(selectedNode)}</span>
              </div>
              <dl className="layer-detail-list">
                <div><dt>类型</dt><dd>{selectedNode.type}</dd></div>
                <div><dt>边界</dt><dd>{boundsLabel(selectedNode)}</dd></div>
                <div><dt>可见性</dt><dd>{selectedNode.visible === false ? "隐藏" : "可见"}</dd></div>
                <div><dt>父节点</dt><dd>{selectedNode.parentId ? nodes[selectedNode.parentId]?.name || selectedNode.parentId : "根节点"}</dd></div>
                {selectedNode.text && <div><dt>文字</dt><dd className="layer-detail-text">{selectedNode.text}</dd></div>}
                {selectedNode.assetUrl && <div><dt>资源候选</dt><dd className="layer-detail-url">{selectedNode.assetUrl}</dd></div>}
                <div><dt>来源</dt><dd className="layer-detail-url">{selectedNode.sourceRef}</dd></div>
              </dl>
              {styles.length > 0 && (
                <div className="layer-style-block">
                  <span className="layer-style-heading">样式字段</span>
                  {styles.map(([key, value]) => <div className="layer-style-row" key={key}><span>{key}</span><code>{String(value)}</code></div>)}
                </div>
              )}
            </>
          ) : <p className="document-note">点击左侧图层查看详情。</p>}
        </div>
      </div>
    </section>
  );
}
