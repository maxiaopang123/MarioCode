import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const out = await mkdtemp(join(tmpdir(), "mariocode-scheduler-push-"));
try {
  await build({
    entryPoints: [join(desktop, "scripts/scheduler-push-smoke/main.ts")],
    outfile: join(out, "smoke.mjs"), bundle: true, platform: "node", format: "esm", target: "node22.19",
    tsconfig: join(desktop, "tsconfig.json"),
    alias: {
      "@main": join(desktop, "src/main"),
      "@contracts": resolve(desktop, "../../packages/contracts/src"),
    },
  });
  const child = spawn(process.execPath, [join(out, "smoke.mjs")], { cwd: desktop, stdio: "inherit", windowsHide: true });
  process.exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
} finally {
  if (!resolve(out).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup target");
  await rm(out, { recursive: true, force: true });
}
