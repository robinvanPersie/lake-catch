import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const appPath = resolve(process.argv[2] ?? "");

if (!appPath || !appPath.endsWith(".app")) {
  throw new Error("用法：node scripts/sign-macos-app.mjs <path-to-app>");
}

await access(appPath);

// Tauri may leave the outer bundle with an executable-only adhoc signature.
// Re-sign the complete bundle so Contents/Resources is sealed as well.
await execFileAsync("codesign", ["--force", "--deep", "--sign", "-", appPath]);
await execFileAsync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

console.log(`Signed and verified macOS app: ${appPath}`);
