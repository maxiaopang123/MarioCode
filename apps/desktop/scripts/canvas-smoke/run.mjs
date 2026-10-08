/**
 * 画布冒烟 runner:esbuild 打包 scripts/canvas-smoke/main.ts(electron /
 * logger / engineProxy / builtinToolsConfig 打桩),再用
 * ELECTRON_RUN_AS_NODE=1 的 electron 跑(node 语义 + Electron ABI,与
 * better-sqlite3 的 Electron 预编译匹配)。
 *
 *   node apps/desktop/scripts/canvas-smoke/run.mjs
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..", "..");
const require = createRequire(join(desktopDir, "package.json"));

// esbuild 是 vite 的传递依赖,从 .pnpm 里找它的 bin。
function findEsbuild() {
  const pnpmDir = join(desktopDir, "..", "..", "node_modules", ".pnpm");
  if (existsSync(pnpmDir)) {
    const candidates = readdirSync(pnpmDir)
      .filter((d) => d.startsWith("esbuild@"))
      .sort()
      .reverse();
    for (const c of candidates) {
      const bin = join(pnpmDir, c, "node_modules", "esbuild", "bin", "esbuild");
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

const esbuild = findEsbuild();
if (!esbuild) {
  console.error("找不到 esbuild(预期在 node_modules/.pnpm 里,vite 的传递依赖)");
  process.exit(1);
}

const outDir = join(desktopDir, "node_modules", ".cache", "canvas-smoke");
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, "canvas-smoke.mjs");

const build = spawnSync(
  // esbuild 的 bin 是 JS 文件(win 上无原生包装),用 node 跑。
  process.execPath,
  [
    esbuild,
    join("scripts", "canvas-smoke", "main.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--tsconfig=tsconfig.json",
    "--packages=external",
    "--alias:electron=./scripts/canvas-smoke/stub-electron.ts",
    "--alias:@main/lib/logger.js=./scripts/canvas-smoke/stub-logger.ts",
    "--alias:@main/network/engineProxy.js=./scripts/canvas-smoke/stub-engineProxy.ts",
    "--alias:@main/tools/builtinToolsConfig.js=./scripts/canvas-smoke/stub-builtinToolsConfig.ts",
    `--outfile=${outfile}`,
    "--log-level=warning",
  ],
  { cwd: desktopDir, stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

// electron 包在 plain node 下导出可执行文件路径。
const electronBin = require("electron");
const run = spawnSync(electronBin, [outfile], {
  cwd: desktopDir,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
process.exit(run.status ?? 1);
