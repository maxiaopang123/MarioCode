import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(desktop, "package.json"));
const { buildSync } = createRequire(require.resolve("vite/package.json"))("esbuild");
const temp = mkdtempSync(join(desktop, ".clawbot-store-smoke-"));
try {
  const here = join(desktop, "scripts/clawbot-store-smoke");
  const output = join(temp, "smoke.cjs");
  buildSync({ entryPoints: [join(here, "main.ts")], outfile: output, bundle: true, platform: "node",
    format: "cjs", target: "node20", external: ["better-sqlite3"], alias: {
      electron: join(here, "stub-electron.ts"), "@main/lib/logger.js": join(here, "stub-logger.ts"),
      "@main": join(desktop, "src/main"), "@contracts": resolve(desktop, "../../packages/contracts/src"),
    } });
  const result = spawnSync(require("electron"), [output], { cwd: desktop, encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CLAWBOT_STORE_SMOKE_DIR: temp } });
  process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
