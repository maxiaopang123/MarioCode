import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const out = await mkdtemp(join(tmpdir(), "mariocode-clawbot-smoke-"));
try {
  await build({
    entryPoints: [join(desktop, "scripts/clawbot-smoke/main.ts")],
    outfile: join(out, "smoke.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.19",
    tsconfig: join(desktop, "tsconfig.json"),
    alias: { "@contracts": resolve(desktop, "../../packages/contracts/src") },
  });
  await import(pathToFileURL(join(out, "smoke.mjs")).href);
} finally {
  if (!resolve(out).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup target");
  await rm(out, { recursive: true, force: true });
}
