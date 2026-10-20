// Bundle scripts/web-reader-smoke/main.ts and run it as Electron's main
// process: the real httpPage / webFetch modules against a loopback fixture
// server. No live network. `pnpm test:web-reader`
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const out = await mkdtemp(join(tmpdir(), "mariocode-web-reader-smoke-"));
const data = join(out, "data");
await mkdir(data);
await cp(join(desktop, "out/preload"), join(out, "preload"), { recursive: true });
await build({
  entryPoints: [join(desktop, "scripts/web-reader-smoke/main.ts")],
  outfile: join(out, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  tsconfig: join(desktop, "tsconfig.json"),
  external: ["electron", "better-sqlite3"],
});
// Bundled native dependencies resolve from the desktop package, outside the artifact directory.
const source = await readFile(join(out, "main.cjs"), "utf8");
await writeFile(join(out, "main.cjs"), `require('node:module').Module._initPaths();\n${source}`);

const child = spawn(require("electron"), [join(out, "main.cjs")], {
  cwd: desktop,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_PATH: join(desktop, "node_modules"),
    MARIOCODE_SMOKE_DATA: data,
    HOME: data,
    USERPROFILE: data,
  },
});
let log = "";
child.stdout.on("data", (c) => {
  log += c;
  process.stdout.write(c);
});
child.stderr.on("data", (c) => {
  log += c;
  process.stderr.write(c);
});
const timeout = setTimeout(() => child.kill(), 120000);
try {
  process.exitCode = await new Promise((r, j) => {
    child.once("error", j);
    child.once("exit", (code) => r(code ?? 1));
  });
  if (!log.includes("PASS: http-first reading")) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  if (!resolve(out).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup target");
  await writeFile(join(data, "electron.log"), log).catch(() => {});
  await rm(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
