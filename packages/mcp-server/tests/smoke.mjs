import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const packageRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const statePath = join(process.env.HOME ?? "", "Library/Application Support/com.lake.catch/state.json");
await access(statePath);
const state = JSON.parse(await readFile(statePath, "utf8"));
const document = [...(state.documents ?? [])]
  .filter((item) => Object.keys(item.nodes ?? {}).length > 0)
  .sort((left, right) => Date.parse(right.syncedAt) - Date.parse(left.syncedAt))[0];
assert.ok(document, "smoke state is missing the expected document");
const documentId = document.id;
const contextRoot = Object.values(document.nodes).find((node) => node.children?.length > 0) ?? Object.values(document.nodes)[0];
assert.ok(contextRoot, "smoke state is missing design nodes");
const contextNodeIds = [contextRoot.id, ...(contextRoot.children ?? [])];
const tempDirectory = await mkdtemp(join(tmpdir(), "lake-mcp-smoke-"));
const tempStatePath = join(tempDirectory, "state.json");
await writeFile(tempStatePath, JSON.stringify({ ...state, contexts: [{ id: "context:smoke", documentId, documentSyncedAt: document.syncedAt, nodeIds: contextNodeIds, createdAt: new Date(0).toISOString(), label: "Smoke context" }] }));

const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
  cwd: packageRoot,
  env: { ...process.env, LANHU_STATE_PATH: tempStatePath },
  stdio: ["pipe", "pipe", "pipe"]
});

let stdout = Buffer.alloc(0);
let stderr = "";
const pending = [];
child.stdout.on("data", (chunk) => {
  stdout = Buffer.concat([stdout, chunk]);
  consume();
});
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

function consume() {
  for (;;) {
    const newline = stdout.indexOf("\n");
    if (newline < 0) return;
    const line = stdout.subarray(0, newline).toString("utf8").trim();
    stdout = stdout.subarray(newline + 1);
    if (!line) continue;
    const value = JSON.parse(line);
    pending.shift()?.(value);
  }
}

function request(id, method, params = {}) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
  child.stdin.write(`${body.toString("utf8")}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 5000);
    pending.push((value) => { clearTimeout(timer); resolve(value); });
  });
}

try {
  const initialize = await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  assert.equal(initialize.result.serverInfo.name, "lake-bridge");
  assert.deepEqual(initialize.result.capabilities.resources, { subscribe: false, listChanged: false });

  const resources = await request(8, "resources/list");
  assert.ok(resources.result.resources.some((resource) => resource.uri === "lake://implementation-context/current"));
  assert.ok(resources.result.resources.some((resource) => resource.uri.includes(encodeURIComponent(documentId))));

  const templates = await request(9, "resources/templates/list");
  assert.ok(templates.result.resourceTemplates.some((template) => template.uriTemplate === "lake://design-document/{documentId}"));

  const currentResource = await request(10, "resources/read", { uri: "lake://implementation-context/current" });
  const currentResourcePayload = JSON.parse(currentResource.result.contents[0].text);
  assert.equal(currentResourcePayload.data.kind, "implementation-context");

  const documentResource = await request(11, "resources/read", { uri: `lake://design-document/${encodeURIComponent(documentId)}` });
  const documentResourcePayload = JSON.parse(documentResource.result.contents[0].text);
  assert.equal(documentResourcePayload.data.kind, "implementation-context");

  const listed = await request(2, "tools/list");
  const toolNames = listed.result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("get_design_specs"));
  assert.ok(toolNames.includes("get_current_implementation_context"));
  assert.ok(toolNames.includes("get_design_context"));
  assert.ok(toolNames.includes("get_implementation_context"));
  assert.ok(toolNames.includes("list_design_contexts"));

  const specs = await request(3, "tools/call", { name: "get_design_specs", arguments: { documentId } });
  assert.ok(specs.result.content?.[0]?.text);
  const specsPayload = JSON.parse(specs.result.content[0].text);
  assert.equal(specsPayload.data.status, "candidate-only");
  assert.ok(specsPayload.data.platform === null || typeof specsPayload.data.platform === "object");
  assert.ok(Array.isArray(specsPayload.data.measurements));

  const listedAssets = await request(31, "tools/call", { name: "list_assets", arguments: { documentId } });
  const listedAssetsPayload = JSON.parse(listedAssets.result.content[0].text);
  assert.ok(Array.isArray(listedAssetsPayload.data));
  for (const asset of listedAssetsPayload.data) {
    assert.ok(["available", "remote-only", "missing", "skipped", "review", "candidate-only"].includes(asset.availability));
    assert.ok(["confirmed", "candidate"].includes(asset.confidence));
  }
  assert.equal(listedAssetsPayload.source.syncVersion, document.syncVersion ?? 1);

  const contexts = await request(4, "tools/call", { name: "list_design_contexts", arguments: {} });
  const contextsPayload = JSON.parse(contexts.result.content[0].text);
  assert.equal(contextsPayload.contexts[0].id, "context:smoke");
  assert.equal(contextsPayload.contexts[0].nodeCount, contextNodeIds.length);
  assert.equal(contextsPayload.contexts[0].stale, false);

  const context = await request(5, "tools/call", { name: "get_design_context", arguments: { contextId: "context:smoke", maxDepth: 8, maxNodes: 1 } });
  const contextPayload = JSON.parse(context.result.content[0].text);
  assert.equal(contextPayload.data.id, "context:smoke");
  assert.equal(contextPayload.data.nodes.length, 1);
  assert.equal(contextPayload.data.limits.maxNodes, 1);
  assert.equal(contextPayload.data.truncated, contextNodeIds.length > 1);
  assert.equal(contextPayload.data.stale, false);
  assert.ok(Array.isArray(contextPayload.data.assets));

  const implementation = await request(51, "tools/call", {
    name: "get_implementation_context",
    arguments: { contextId: "context:smoke", maxDepth: 8, maxNodes: 20 }
  });
  const implementationPayload = JSON.parse(implementation.result.content[0].text);
  assert.equal(implementationPayload.data.kind, "implementation-context");
  assert.equal(implementationPayload.data.mode, "design-context");
  assert.equal(implementationPayload.data.contextId, "context:smoke");
  assert.ok(implementationPayload.data.target);
  assert.ok(Array.isArray(implementationPayload.data.nodes));
  assert.ok(Array.isArray(implementationPayload.data.assets));
  assert.ok(Array.isArray(implementationPayload.data.implementationGuidance));
  assert.ok(Array.isArray(implementationPayload.data.warnings));
  assert.ok(implementationPayload.data.truncation);

  const fullImplementation = await request(52, "tools/call", {
    name: "get_implementation_context",
    arguments: { documentId, maxDepth: 32, maxNodes: 2000 }
  });
  const fullImplementationPayload = JSON.parse(fullImplementation.result.content[0].text);
  assert.equal(fullImplementationPayload.data.mode, "document");
  assert.equal(fullImplementationPayload.data.contextId, null);
  assert.ok(["ios", "android", "web", "unknown"].includes(fullImplementationPayload.data.target.platform));
  assert.ok(["pt", "dp", "px", "unknown"].includes(fullImplementationPayload.data.target.designUnit));
  assert.ok(typeof fullImplementationPayload.data.target.viewportSource === "string");
  assert.ok(typeof fullImplementationPayload.data.target.contentHeightSource === "string");
  assert.ok(typeof fullImplementationPayload.data.target.scrollableSource === "string");
  assert.ok(fullImplementationPayload.data.implementationGuidance.some((item) => item.includes("框架无关")));
  assert.ok(Array.isArray(fullImplementationPayload.data.nodes));
  assert.ok(fullImplementationPayload.data.pageStructure === null || typeof fullImplementationPayload.data.pageStructure === "object");
  const implementationNodes = [];
  const collectImplementationNodes = (node) => {
    implementationNodes.push(node);
    for (const child of node.children ?? []) collectImplementationNodes(child);
  };
  for (const root of fullImplementationPayload.data.nodes) collectImplementationNodes(root);
  assert.equal(implementationNodes.length, fullImplementationPayload.data.summary.nodeCount);
  assert.ok(implementationNodes.some((node) => node.type.toLowerCase().includes("text") && node.text), "confirmed text layers should expose text to AI");
  assert.equal(fullImplementationPayload.data.assets.length, Object.keys(document.assets).length);
  if (document.assets.length > 0 && document.assets.every((asset) => asset.sourceUrl)) {
    assert.ok(fullImplementationPayload.data.assets.every((asset) => asset.availability === "remote-only" || asset.availability === "available" || asset.availability === "skipped"), "confirmed URL assets should expose usable availability");
  }

  const currentImplementation = await request(53, "tools/call", {
    name: "get_current_implementation_context",
    arguments: {}
  });
  const currentImplementationPayload = JSON.parse(currentImplementation.result.content[0].text);
  assert.equal(currentImplementationPayload.data.kind, "implementation-context");
  assert.equal(currentImplementationPayload.data.mode, "document");
  assert.ok(currentImplementationPayload.source.url);

  const missingDocument = await request(6, "tools/call", { name: "get_design_specs", arguments: { documentId: "missing" } });
  assert.equal(missingDocument.error.code, -32000);

  const missingNode = await request(7, "tools/call", { name: "get_node", arguments: { documentId, nodeId: "missing" } });
  assert.equal(missingNode.error.code, -32000);

  console.log("MCP smoke tests passed");
} finally {
  child.kill();
  await delay(50);
  await rm(tempDirectory, { recursive: true, force: true });
  if (child.exitCode !== null && child.exitCode !== 0 && stderr) process.stderr.write(stderr);
}
