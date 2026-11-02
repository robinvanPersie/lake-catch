import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const serverDirectory = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(root, "apps/desktop/src-tauri/target/release/bundle/macos/Lake Catch.app/Contents/Resources/mcp-server");
const nodePath = resolve(serverDirectory, "node");
const entryPath = resolve(serverDirectory, "index.mjs");

await access(nodePath);
await access(entryPath);

if (process.platform === "darwin") {
  const dependencies = execFileSync("otool", ["-L", nodePath], { encoding: "utf8" });
  const external = dependencies
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter((dependency) => dependency && dependency.startsWith("/") && !dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/"));
  assert.deepEqual(external, [], `bundled Node has external dynamic library references: ${external.join(", ")}`);
}

const child = spawn(nodePath, [entryPath], {
  cwd: serverDirectory,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"]
});

let output = Buffer.alloc(0);
let errorOutput = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  output = Buffer.concat([output, chunk]);
  for (;;) {
    const newline = output.indexOf("\n");
    if (newline < 0) return;
    const line = output.subarray(0, newline).toString("utf8").trim();
    output = output.subarray(newline + 1);
    if (!line) continue;
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  }
});
child.stderr.on("data", (chunk) => { errorOutput += chunk.toString("utf8"); });

function request(method, params = {}) {
  const id = nextId++;
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
  child.stdin.write(`${body.toString("utf8")}\n`);
  return new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 5000);
    pending.set(id, (response) => {
      clearTimeout(timer);
      resolveResponse(response);
    });
  });
}

try {
  const initialize = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "lake-bundle-verifier", version: "1" }
  });
  assert.equal(initialize.result?.serverInfo?.name, "lake-bridge");
  assert.deepEqual(initialize.result?.capabilities?.resources, { subscribe: false, listChanged: false });

  const tools = await request("tools/list");
  assert.ok(tools.result?.tools?.some((tool) => tool.name === "get_current_implementation_context"));

  const resources = await request("resources/list");
  assert.ok(Array.isArray(resources.result?.resources));
  assert.ok(resources.result.resources.some((resource) => resource.uri === "lake://implementation-context/current"));
  assert.ok(resources.result.resources.some((resource) => resource.uri === "lake://design-documents"));

  const templates = await request("resources/templates/list");
  assert.ok(templates.result?.resourceTemplates?.some((template) => template.uriTemplate === "lake://design-document/{documentId}"));
  console.log(`MCP bundle verified: ${serverDirectory}`);
} finally {
  child.kill();
  if (child.exitCode !== null && child.exitCode !== 0 && errorOutput) process.stderr.write(errorOutput);
}
