import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const documentId = process.env.LANHU_DOCUMENT_ID ?? process.argv[2];
const outputPath = resolve(process.env.LANHU_IMPLEMENTATION_OUTPUT ?? process.argv[3] ?? "examples/ai-implementation/index.html");
const manifestPath = resolve(process.env.LANHU_IMPLEMENTATION_MANIFEST ?? process.argv[4] ?? "examples/ai-implementation/implementation-context.json");
const packageRoot = resolve(new URL("../../packages/mcp-server", import.meta.url).pathname);
const statePath = process.env.LANHU_STATE_PATH;

if (!documentId) {
  throw new Error("请提供要实现的 documentId，例如：LANHU_DOCUMENT_ID=... node examples/ai-implementation/generate.mjs");
}

function requestMcp(child, id, method, params = {}) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
  child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  child.stdin.write(body);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP 请求超时：${method}`)), 10000);
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      let start = 0;
      let length = 0;
      if (headerEnd >= 0) {
        const header = buffer.subarray(0, headerEnd).toString("ascii");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) return;
        length = Number(match[1]);
        start = headerEnd + 4;
      } else {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        start = 0;
        length = newline;
      }
      if (buffer.byteLength < start + length) return;
      child.stdout.off("data", onData);
      clearTimeout(timer);
      resolvePromise(JSON.parse(buffer.subarray(start, start + length).toString("utf8")));
    };
    child.stdout.on("data", onData);
  });
}

function flatten(nodes, output = []) {
  for (const node of nodes ?? []) {
    output.push(node);
    flatten(node.children, output);
  }
  return output;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cssColor(value, fallback) {
  return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
}

function renderNode(node, originX, originY, rootId) {
  if (node.visible === false || !node.bounds || node.bounds.width <= 0 || node.bounds.height <= 0) return "";
  if (node.id === rootId) return "";
  const type = String(node.type ?? "").toLowerCase();
  const text = node.text ?? (type.includes("text") ? node.name : "");
  const style = node.style ?? {};
  const isText = Boolean(text) || type.includes("text");
  const isImage = type.includes("image") || type.includes("bitmap") || type.includes("photo");
  const x = node.bounds.x - originX;
  const y = node.bounds.y - originY;
  const css = [
    `left:${x}px`,
    `top:${y}px`,
    `width:${node.bounds.width}px`,
    `height:${node.bounds.height}px`,
    `opacity:${typeof style.opacity === "number" ? (style.opacity > 1 ? style.opacity / 100 : style.opacity) : 1}`,
    `transform:rotate(${typeof style.rotation === "number" ? style.rotation : 0}deg)`,
    `background:${isText ? "transparent" : cssColor(style.backgroundColor, "rgba(125, 135, 150, .08)")}`,
    `color:${cssColor(style.color, "#1f2937")}`,
    `border-radius:${typeof style.borderRadius === "number" ? style.borderRadius : 0}px`,
    `font-size:${typeof style.fontSize === "number" ? style.fontSize : 14}px`,
    `font-weight:${style.fontWeight ?? (isText ? 400 : 400)}`,
    `line-height:${typeof style.lineHeight === "number" ? `${style.lineHeight}px` : "normal"}`,
    `text-align:${style.textAlign ?? "left"}`
  ].join(";");
  const label = escapeHtml(node.name || node.id);
  const content = isText
    ? escapeHtml(text)
    : isImage && node.assetUrl
      ? `<img src="${escapeHtml(node.assetUrl)}" alt="${label}" loading="lazy">`
      : `<span class="asset-placeholder">${isImage ? "资源待确认" : ""}</span>`;
  return `<div class="design-node ${isText ? "text-node" : "shape-node"} ${isImage ? "image-node" : ""}" data-node-id="${escapeHtml(node.id)}" title="${label}" style="${css}">${content}</div>`;
}

const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
  cwd: packageRoot,
  env: { ...process.env, ...(statePath ? { LANHU_STATE_PATH: statePath } : {}) },
  stdio: ["pipe", "pipe", "pipe"]
});

try {
  const initialize = await requestMcp(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "implementation-preview", version: "1" } });
  if (initialize.error) throw new Error(initialize.error.message);
  const response = await requestMcp(child, 2, "tools/call", {
    name: "get_implementation_context",
    arguments: { documentId }
  });
  if (response.error) throw new Error(response.error.message);
  const envelope = JSON.parse(response.result.content[0].text);
  const data = envelope.data;
  const nodes = flatten(data.nodes);
  const bounded = nodes.filter((node) => node.bounds && node.bounds.width > 0 && node.bounds.height > 0);
  const root = data.tree?.[0] ?? data.nodes?.[0] ?? bounded[0];
  const rootId = root?.id ?? null;
  // Lake's artboard is the coordinate frame. Descendants are already local to it;
  // using the root's absolute page position here would inflate the preview.
  const hasRootFrame = Boolean(root?.bounds?.width && root?.bounds?.height);
  const originX = hasRootFrame ? 0 : Math.min(0, ...bounded.map((node) => node.bounds.x));
  const originY = hasRootFrame ? 0 : Math.min(0, ...bounded.map((node) => node.bounds.y));
  const width = hasRootFrame
    ? root.bounds.width
    : Math.max(0, ...bounded.map((node) => node.bounds.x - originX + node.bounds.width));
  const height = hasRootFrame
    ? root.bounds.height
    : Math.max(0, ...bounded.map((node) => node.bounds.y - originY + node.bounds.height));
  const canvasWidth = width > 0 ? width : data.target.viewportWidth > 0 ? data.target.viewportWidth : 375;
  const canvasHeight = height > 0 ? height : data.target.contentHeight > 0 ? data.target.contentHeight : 620;
  const textCount = nodes.filter((node) => node.text || String(node.type).toLowerCase().includes("text")).length;
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const localAssetCount = data.assets.filter((asset) => asset.availability === "available").length;
  const remoteAssetCount = data.assets.filter((asset) => asset.availability === "remote-only").length;
  const usableAssetCount = localAssetCount + remoteAssetCount;
  const unresolvedAssetCount = data.assets.length - usableAssetCount;
  const statusClass = data.status === "confirmed" ? "status-confirmed" : "status-partial";
  const warningItems = warnings.length
    ? `<ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
    : "<p>没有额外告警。</p>";
  const manifest = {
    schemaVersion: "0.1",
    kind: "ai-implementation-input",
    generatedAt: new Date().toISOString(),
    documentId,
    source: data.source,
    status: data.status,
    target: data.target,
    summary: data.summary,
    limits: data.limits,
    truncated: data.truncated,
    truncation: data.truncation,
    warnings,
    implementationGuidance: data.implementationGuidance,
    pageStructure: data.pageStructure,
    assets: data.assets,
    tree: data.nodes,
    nodes: data.nodes
  };
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI 实现验证 · ${escapeHtml(data.target.title ?? "设计稿")}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #eef1f5; color: #17202b; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 390px; }
    header { position: sticky; top: 0; z-index: 5; display: flex; justify-content: space-between; gap: 20px; align-items: center; padding: 14px 20px; background: rgba(255,255,255,.94); border-bottom: 1px solid #dfe4ea; backdrop-filter: blur(12px); }
    header strong { font-size: 14px; }
    header span { color: #647181; font-size: 12px; }
    .status { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; padding: 3px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .status-confirmed { color: #116149; background: #dff7eb; }
    .status-partial { color: #8a4b0f; background: #fff0d9; }
    main { display: flex; justify-content: center; padding: 28px 18px 64px; }
    .device { position: relative; flex: 0 0 auto; overflow: hidden; background: #fff; box-shadow: 0 20px 50px rgba(27, 39, 54, .16); }
    .design-node { position: absolute; overflow: hidden; pointer-events: none; }
    .text-node { white-space: pre-wrap; overflow-wrap: anywhere; }
    .shape-node { border: 1px solid rgba(120, 132, 146, .24); }
    .image-node img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .asset-placeholder { display: block; width: 100%; height: 100%; background: repeating-linear-gradient(135deg, #f4f6f8 0, #f4f6f8 8px, #e8edf2 8px, #e8edf2 16px); color: #7b8794; font-size: 10px; text-align: center; padding-top: 12px; }
    .legend { position: fixed; right: 18px; bottom: 18px; width: min(360px, calc(100vw - 36px)); max-height: min(280px, 42vh); overflow: auto; padding: 12px 14px; background: #17202b; color: #fff; border-radius: 6px; font-size: 11px; line-height: 1.5; box-shadow: 0 10px 24px rgba(0,0,0,.18); }
    .legend strong { display: block; margin-bottom: 5px; }
    .legend p { margin: 5px 0; color: #d9e0e8; }
    .legend ul { margin: 6px 0 0; padding-left: 18px; color: #ffd79b; }
  </style>
</head>
<body>
  <header><strong>${escapeHtml(data.target.title ?? "AI 实现验证")}<span class="status ${statusClass}">${escapeHtml(data.status)}</span></strong><span>${nodes.length} 个节点 · ${textCount} 个文本 · ${data.assets.length} 个资源 · ${canvasWidth}×${canvasHeight}</span></header>
  <main><div class="device" style="width:${canvasWidth}px;height:${canvasHeight}px">${nodes.map((node) => renderNode(node, originX, originY, rootId)).join("")}</div></main>
  <aside class="legend"><strong>实现上下文诊断</strong><p>坐标基准：根画板；页面滚动：${data.target.scrollable === true ? "是" : data.target.scrollable === false ? "否" : "待确认"}</p><p>平台单位：${escapeHtml(data.target.designUnit ?? "unknown")} · 视口：${data.target.viewportWidth ?? "待确认"} · 可用资源：${usableAssetCount}/${data.assets.length}（本地 ${localAssetCount}，远程 ${remoteAssetCount}）</p><p>资源缺少 URL 时保留为占位，不使用整页长图替代结构化实现。</p>${unresolvedAssetCount || warnings.length ? warningItems : "<p>资源均可通过本地或远程 URL 使用。</p>"}</aside>
</body>
</html>`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, manifestPath, documentId, nodeCount: nodes.length, textCount, assetCount: data.assets.length, status: data.status, truncated: data.truncated }, null, 2));
} finally {
  child.kill();
}
