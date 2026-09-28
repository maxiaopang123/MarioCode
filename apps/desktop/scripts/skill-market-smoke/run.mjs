#!/usr/bin/env node
// Offline smoke for the skill marketplace core (apps/desktop/src/main/lib/skillMarket.ts).
//
// Bundles main.ts with esbuild (tsconfig paths resolve @main/* / @contracts/*),
// swapping the logger / db / repositories modules for in-memory stubs, then
// runs it under plain node with HOME/USERPROFILE pointed at a temp dir so the
// real ~/.mcode is never touched. No network: git sources are only classified,
// never cloned; the add/refresh flow is exercised with local-directory sources.
//
//   node apps/desktop/scripts/skill-market-smoke/run.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "../..");
const repo = path.resolve(desktop, "../..");

function findEsbuild() {
  const pnpmDir = path.join(repo, "node_modules/.pnpm");
  const candidates = [path.join(pnpmDir, "node_modules/esbuild")];
  if (existsSync(pnpmDir)) {
    for (const d of readdirSync(pnpmDir).filter((n) => /^esbuild@/.test(n)).sort().reverse()) {
      candidates.push(path.join(pnpmDir, d, "node_modules/esbuild"));
    }
  }
  const req = createRequire(import.meta.url);
  for (const c of candidates) {
    if (existsSync(path.join(c, "package.json"))) return req(c);
  }
  throw new Error("esbuild not found under node_modules/.pnpm");
}

const esbuild = findEsbuild();
const out = mkdtempSync(path.join(tmpdir(), "mcode-skill-market-smoke-"));
const home = path.join(out, "home");
const stubs = path.join(here, "stubs.ts");
const STUBBED = new Set(["@main/lib/logger.js", "@main/store/db.js", "@main/store/repositories.js"]);

try {
  await esbuild.build({
    // --live: clone the real builtin market from GitHub (network) instead of the offline cases.
    entryPoints: [path.join(here, process.argv.includes("--live") ? "live.ts" : "main.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    tsconfig: path.join(desktop, "tsconfig.json"),
    outfile: path.join(out, "smoke.mjs"),
    logLevel: "error",
    plugins: [
      {
        name: "stub-electron-modules",
        setup(b) {
          b.onResolve({ filter: /^@main\/(lib\/logger|store\/db|store\/repositories)\.js$/ }, (args) =>
            STUBBED.has(args.path) ? { path: stubs } : undefined,
          );
        },
      },
    ],
  });
  const r = spawnSync(process.execPath, [path.join(out, "smoke.mjs")], {
    env: { ...process.env, HOME: home, USERPROFILE: home, SMOKE_HOME: home },
    encoding: "utf-8",
  });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
