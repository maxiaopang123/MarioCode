/** Build the Pi host separately from Electron. Pi itself is loaded from the
 * selected installation at runtime, not bundled into this helper. */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(desktop, "package.json"));
const viteRequire = createRequire(require.resolve("vite/package.json"));
const { build } = viteRequire("esbuild");
const result = await build({
  entryPoints: [resolve(desktop, "src/main/providers/pi-sdk/piHost.ts")],
  outfile: resolve(desktop, "out/pi-host/piHost.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.19",
  external: ["@earendil-works/pi-coding-agent", "electron"],
  alias: {
    "@main": resolve(desktop, "src/main"),
    "@contracts": resolve(desktop, "../../packages/contracts/src"),
  },
  banner: {
    js: 'import { createRequire as __hostCreateRequire } from "node:module"; const require = __hostCreateRequire(import.meta.url);',
  },
  metafile: true,
});
for (const output of Object.values(result.metafile.outputs)) {
  if (output.imports.some((item) => item.path === "electron")) {
    throw new Error("Pi host cannot depend on Electron");
  }
}
console.log("Built isolated Node Pi host: out/pi-host/piHost.mjs");
