import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const root = join(desktop, ".turbo/ssh-mcp-smoke"); await mkdir(root, { recursive: true });
const data = await mkdtemp(join(root, "run-"));
await build({ entryPoints: [join(desktop, "scripts/ssh-mcp-smoke/main.ts")], outfile: join(data, "main.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22",
  external: ["electron", "better-sqlite3", "ssh2", "@modelcontextprotocol/sdk/*"], tsconfig: join(desktop, "tsconfig.json"),
  define: { __dirname: JSON.stringify(join(desktop, "out/main")), "process.env.SSH_TEST_DESKTOP": JSON.stringify(desktop) },
  alias: { "@main": join(desktop, "src/main"), "@contracts": resolve(desktop, "../../packages/contracts/src") },
});
const code = await new Promise(resolveCode => {
  const child = spawn(require("electron"), [join(data, "main.cjs")], { cwd: desktop, windowsHide: true, stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, USERPROFILE: data, HOME: data, SSH_TEST_DATA: data } });
  child.once("exit", c => resolveCode(c ?? 1));
});
console.log(`SSH/MCP test artifacts: ${data}`); process.exit(code);
