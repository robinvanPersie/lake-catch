import { build } from "../node_modules/.pnpm/node_modules/esbuild/lib/main.js";
import { chmod, copyFile, mkdir, realpath, rm, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const outputDirectory = resolve(root, "apps/desktop/src-tauri/resources/mcp-server");
const outputFile = resolve(outputDirectory, "index.mjs");
const nodeBinary = resolve(outputDirectory, "node");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve(root, "packages/mcp-server/src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: outputFile,
  sourcemap: false,
  minify: false
});

const sourceNodeBinary = await realpath(process.execPath);
await copyFile(sourceNodeBinary, nodeBinary);
await chmod(nodeBinary, 0o755);

async function dependenciesOf(file) {
  const { stdout } = await execFileAsync("otool", ["-L", file]);
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean);
}

async function rpathsOf(file) {
  const { stdout } = await execFileAsync("otool", ["-l", file]);
  const lines = stdout.split("\n");
  const paths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes("LC_RPATH")) continue;
    const pathLine = lines.slice(index, index + 5).find((line) => line.trim().startsWith("path "));
    if (pathLine) paths.push(pathLine.trim().split(/\s+/)[1]);
  }
  return paths;
}

function isSystemDependency(dependency) {
  return dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/") || dependency.startsWith("/usr/lib/");
}

function resolveDependency(dependency, current) {
  if (isAbsolute(dependency)) return dependency;
  // Resolve against the original file location. The copied file has the same
  // load commands, while its dependencies are still located in Homebrew's
  // Cellar until they are copied into the bundle.
  const sourceBase = dirname(current.original);
  if (dependency.startsWith("@loader_path/")) {
    return resolve(sourceBase, dependency.slice("@loader_path/".length));
  }
  if (dependency.startsWith("@rpath/")) {
    const suffix = dependency.slice("@rpath/".length);
    return rpathsOf(current.source).then(async (rpaths) => {
      for (const rpath of rpaths) {
        const expanded = rpath === "@loader_path"
          ? sourceBase
          : rpath.startsWith("@loader_path/")
            ? resolve(sourceBase, rpath.slice("@loader_path/".length))
            : resolve(sourceBase, rpath);
        const candidate = resolve(expanded, suffix);
        try {
          await lstat(candidate);
          return candidate;
        } catch {
          // Try the next LC_RPATH entry.
        }
      }
      throw new Error(`无法解析 ${dependency}（文件：${current.original}）`);
    });
  }
  throw new Error(`无法解析动态库依赖 ${dependency}（文件：${current.original}）`);
}

const pending = [{ source: nodeBinary, original: sourceNodeBinary }];
const copied = new Map();
while (pending.length > 0) {
  const current = pending.shift();
  for (const dependency of await dependenciesOf(current.source)) {
    if (isSystemDependency(dependency)) continue;
    const source = await resolveDependency(dependency, current);
    const name = basename(source);
    if (!name) throw new Error(`动态库依赖没有文件名：${dependency}`);
    const sourceRealPath = await realpath(source);
    const destination = resolve(outputDirectory, name);
    if (!copied.has(sourceRealPath)) {
      await copyFile(sourceRealPath, destination);
      await chmod(destination, 0o755);
      copied.set(sourceRealPath, destination);
      pending.push({ source: destination, original: sourceRealPath });
      await execFileAsync("install_name_tool", ["-id", `@loader_path/${name}`, destination]);
    }
    await execFileAsync("install_name_tool", ["-change", dependency, `@loader_path/${name}`, current.source]);
  }
}

const bundledFiles = [nodeBinary, ...copied.values()];
for (const file of bundledFiles) {
  await execFileAsync("codesign", ["--force", "--sign", "-", file]);
}

const unresolved = [];
for (const file of bundledFiles) {
  const dependencies = await dependenciesOf(file);
  for (const dependency of dependencies) {
    if (isSystemDependency(dependency)) continue;
    if (!dependency.startsWith("@loader_path/")) unresolved.push(`${file}: ${dependency}`);
  }
}
if (unresolved.length > 0) {
  throw new Error(`打包后的 MCP 仍包含外部动态库引用：\n${unresolved.join("\n")}`);
}

console.log(`Prepared bundled MCP server at ${outputFile}`);
console.log(`Copied Node runtime from ${process.execPath}`);
console.log(`Copied ${copied.size} runtime libraries`);
