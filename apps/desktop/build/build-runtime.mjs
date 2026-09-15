import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [resolve(desktop, "build/build-pi-host.mjs")], { cwd: desktop, stdio: "inherit", windowsHide: true });
execFileSync(process.execPath, [resolve(desktop, "node_modules/electron-vite/bin/electron-vite.js"), "build"], {
  cwd: desktop, stdio: "inherit", windowsHide: true,
  env: { ...process.env, MARIOCODE_RUNTIME_BUILD_ONLY: "1" },
});
