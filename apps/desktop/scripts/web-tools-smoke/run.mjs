// Bundle main.ts (the real web_search / web_fetch modules, in-memory settings)
// and run it as Electron's main process. Hits the live web. `pnpm test:web-tools`
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const stubs = join(desktop, "scripts/shared-provider-smoke");
const out = await mkdtemp(join(tmpdir(), "mariocode-web-tools-smoke-"));
let code = 1;
try {
  await build({
    entryPoints: [join(desktop, "scripts/web-tools-smoke/main.ts")],
    outfile: join(out, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron"],
    tsconfig: join(desktop, "tsconfig.json"),
    alias: {
      "@main/store/db.js": join(stubs, "stub-db.ts"),
      "@main/store/repositories.js": join(stubs, "stub-db.ts"),
      "@main/lib/logger.js": join(stubs, "stub-logger.ts"),
      "@main": join(desktop, "src/main"),
      "@contracts": resolve(desktop, "../../packages/contracts/src"),
    },
  });
  code = await new Promise((resolveCode) => {
    const child = spawn(require("electron"), [join(out, "main.cjs")], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    child.once("exit", (c) => resolveCode(c ?? 1));
  });
} finally {
  if (!resolve(out).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup target");
  await rm(out, { recursive: true, force: true });
}
process.exit(code);
