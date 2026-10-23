/** One-off audit: which dependency is imported from which build target.
 *  main/preload need node_modules at runtime (externalizeDepsPlugin);
 *  renderer imports are already inlined into out/renderer by Vite. */
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const deps = Object.keys(pkg.dependencies);

const files = [];
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "dist", "release", "out"].includes(e.name)) continue;
      walk(p);
    } else if ([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"].includes(extname(e.name))) {
      files.push(p);
    }
  }
}
for (const r of ["src", "build", "scripts"]) {
  try { walk(r); } catch { /* dir may be absent */ }
}

const contents = files.map((f) => [f, readFileSync(f, "utf8")]);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const dep of [...deps].sort()) {
  const re = new RegExp(
    String.raw`(?:from|require\(|import\(|import)\s*['"]` + esc(dep) + String.raw`(?:/[^'"]*)?['"]`,
  );
  const hits = { main: [], preload: [], renderer: [], build: [], scripts: [] };
  for (const [f, src] of contents) {
    if (!re.test(src)) continue;
    const norm = f.replace(/\\/g, "/");
    const bucket = norm.startsWith("src/main") ? "main"
      : norm.startsWith("src/preload") ? "preload"
      : norm.startsWith("src/renderer") ? "renderer"
      : norm.startsWith("build/") ? "build" : "scripts";
    hits[bucket].push(f);
  }
  const parts = Object.entries(hits).filter(([, v]) => v.length).map(([k, v]) => `${k}(${v.length})`);
  console.log(`${dep.padEnd(42)} ${parts.join(" ") || "*** UNUSED ***"}`);
}
