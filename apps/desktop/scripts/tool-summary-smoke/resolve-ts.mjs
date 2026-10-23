/**
 * ESM resolve hook for the smoke tests that import renderer modules directly.
 *
 * The renderer is bundled with esbuild/Vite, so its imports use the compiled
 * specifier form (`./commandSummary.js`) even though the file on disk is
 * `commandSummary.ts`. Node's type stripping handles the TypeScript syntax but
 * NOT that extension rewrite, so a plain `import … from "…/stepSummary.ts"`
 * dies on the nested `./commandSummary.js`.
 *
 * This hook maps a relative `*.js` specifier to the sibling `*.ts` only when
 * the `.js` file does not exist, i.e. exactly the bundler convention and
 * nothing else. Registered via `--import` from the npm scripts.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const target = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(target))) {
      const ts = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(ts))) return nextResolve(ts.href, context);
    }
  }
  return nextResolve(specifier, context);
}
