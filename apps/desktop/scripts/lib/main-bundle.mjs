/**
 * Bundle one main-process TypeScript module into an ESM file that plain `node`
 * can import, so main-process behaviour (env building, timeout policies) can be
 * exercised without launching Electron.
 *
 * Two problems this solves, both of which bite every main-process smoke test:
 *
 *  1. The module graph reaches `electron` and `better-sqlite3`. The former does
 *     not exist outside Electron; the latter is a native .node built for
 *     Electron's ABI, so importing it under plain node throws. Both are
 *     replaced with inert shims — tests inject their own collaborators, so the
 *     real implementations never run.
 *  2. Bundled CJS dependencies still call `require()`, which an ESM output has
 *     no binding for. The banner installs one via `createRequire`.
 */
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(desktopDir, "package.json"));
// esbuild ships inside vite; the repo's own build scripts reach it the same way.
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");

const STUBS = {
  electron: [
    "const inert = () => ({});",
    "export const session = { fromPartition: inert, defaultSession: {} };",
    "export const app = { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false };",
    "export const net = {};",
    "export const shell = {};",
    "export const ipcMain = {};",
    "export const BrowserWindow = class {};",
    "export const dialog = {};",
    "export const nativeTheme = {};",
    "export const Menu = {};",
    "export const Notification = class {};",
    "export const clipboard = {};",
    "export const safeStorage = {};",
    "export const powerMonitor = {};",
    "export default {};",
  ].join("\n"),
  "better-sqlite3": [
    "export default class Database {",
    "  constructor() { throw new Error('better-sqlite3 is stubbed out in main-process smoke tests'); }",
    "}",
  ].join("\n"),
};

const shims = {
  name: "unrunnable-shims",
  setup(b) {
    const filter = new RegExp(`^(${Object.keys(STUBS).join("|")})$`);
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: "shim" }));
    b.onLoad({ filter: /.*/, namespace: "shim" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
  },
};

let outDirPromise;
function outDir() {
  outDirPromise ??= mkdtemp(join(tmpdir(), "mariocode-main-bundle-"));
  return outDirPromise;
}

/**
 * Bundle `entry` (absolute path) and import the result.
 * Returns the module namespace.
 */
export async function importMainModule(entry) {
  const dir = await outDir();
  const outfile = join(dir, `${entry.split(/[\\/]/).pop().replace(/\.tsx?$/, "")}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.19",
    alias: {
      "@main": resolve(desktopDir, "src/main"),
      "@contracts": resolve(desktopDir, "../../packages/contracts/src"),
    },
    plugins: [shims],
    banner: { js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
    logLevel: "warning",
  });
  return import(pathToFileURL(outfile).href);
}
