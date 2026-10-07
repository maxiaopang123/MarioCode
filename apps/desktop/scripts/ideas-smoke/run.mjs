import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const base = join(desktop, ".turbo");
await mkdir(base, { recursive: true });
const out = await mkdtemp(join(base, "ideas-smoke-"));
try {
  const data = join(out, "data");
  await mkdir(data);
  await build({ entryPoints: [join(desktop, "scripts/ideas-smoke/main.ts")], outfile: join(out, "main.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22", tsconfig: join(desktop, "tsconfig.json"), external: ["electron", "better-sqlite3"] });
  const child = spawn(require("electron"), [join(out, "main.cjs")], { cwd: desktop, stdio: "inherit", windowsHide: true, env: { ...process.env, MARIOCODE_SMOKE_DATA: data } });
  process.exitCode = await new Promise((resolvePromise, reject) => { child.once("error", reject); child.once("exit", code => resolvePromise(code ?? 1)); });
} finally {
  if (!resolve(out).startsWith(resolve(base) + sep)) throw new Error("Unsafe smoke cleanup path");
  await rm(out, { recursive: true, force: true });
}
