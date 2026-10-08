import { createRequire } from "node:module";
import { mkdtemp, mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const root = resolve(desktop, "../../.turbo/browser-native");
await mkdir(root, { recursive: true });
const out = await mkdtemp(join(root, "run-"));
const data = join(out, "data");
await mkdir(data);
await mkdir(join(out, "main"));
await cp(join(desktop, "out/preload"), join(out, "preload"), { recursive: true });
await build({
  entryPoints: [join(desktop, "scripts/browser-lifecycle-smoke/main.ts")], outfile: join(out, "main/main.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node22", tsconfig: join(desktop, "tsconfig.json"),
  external: ["electron", "better-sqlite3"], alias: { "@main/window.js": join(desktop, "scripts/browser-lifecycle-smoke/window.ts") },
});
// Bundled native dependencies resolve from the desktop package, outside the artifact directory.
const source = await readFile(join(out, "main/main.cjs"), "utf8");
await writeFile(join(out, "main/main.cjs"), `require('node:module').Module._initPaths();\n${source}`);
const child = spawn(require("electron"), [join(out, "main/main.cjs")], {
  cwd: desktop, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_PATH: join(desktop, "node_modules"), MARIOCODE_SMOKE_DATA: data, HOME: data, USERPROFILE: data },
});
let log = "";
child.stdout.on("data", c => { log += c; process.stdout.write(c); });
child.stderr.on("data", c => { log += c; process.stderr.write(c); });
const timeout = setTimeout(() => child.kill(), 60000);
try {
  process.exitCode = await new Promise((r,j) => { child.once("error",j); child.once("exit",code=>r(code ?? 1)); });
  if (!log.includes("PASS: unfinished-resource")) process.exitCode = 1;
  console.log(`Artifacts: ${data}`);
} finally { clearTimeout(timeout); await writeFile(join(data,"electron.log"), log); }
