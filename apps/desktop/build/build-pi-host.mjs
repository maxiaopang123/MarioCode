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
  write: false,
});
require("node:fs").writeFileSync(
  resolve(desktop, "out/pi-host/metafile.json"),
  JSON.stringify(result.metafile, null, 2),
);
for (const [outputFile, output] of Object.entries(result.metafile.outputs)) {
  const electronImports = output.imports.filter(
    (item) => item.path === "electron" || item.external === true && item.path === "electron",
  );
  if (electronImports.length > 0) {
    // Walk the input files bundled into this output and report the ones that
    // themselves import "electron" — that's the actionable origin.
    const bundledInputs = new Set(Object.keys(output.inputs));
    const culprits = Object.entries(result.metafile.inputs)
      .filter(
        ([file, input]) =>
          bundledInputs.has(file) &&
          input.imports.some((i) => i.path === "electron" || (i.external === true && i.path === "electron")),
      )
      .map(([file]) => file);
    throw new Error(
      `Pi host cannot depend on Electron (in ${outputFile}; imported by: ${culprits.join(", ") || "unknown"})`,
    );
  }
}
console.log("Built isolated Node Pi host: out/pi-host/piHost.mjs");
