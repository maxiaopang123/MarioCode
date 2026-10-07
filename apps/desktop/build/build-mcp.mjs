import { createRequire } from "node:module";
import { dirname,resolve } from "node:path";
import { fileURLToPath } from "node:url";
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const require=createRequire(resolve(desktop,"package.json"));
const {build}=createRequire(require.resolve("vite/package.json"))("esbuild");
await build({entryPoints:[resolve(desktop,"src/main/mcp/sshServer.ts")],outfile:resolve(desktop,"out/mcp/mariocode-mcp-ssh/stdio.mjs"),bundle:true,platform:"node",format:"esm",target:"node22.19",banner:{js:'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'}});
console.log("Built optional SSH stdio MCP server");
