// electron-builder downloads winCodeSign-2.6.0.7z and extracts it into a
// numbered temp dir, renaming it to `winCodeSign-2.6.0` only when 7-Zip exits
// cleanly. Without Windows Developer Mode (or admin), the two macOS symlinks
// in darwin/10.12/lib/*.dylib cannot be created, 7-Zip exits 2 and the whole
// Windows build fails. Those files are only used for macOS signing, so copy
// any complete extraction to the expected name. No-op when it already exists
// or nothing has been downloaded yet (electron-builder will download it, fail
// once, and the next run of this script fixes it).
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const cache = join(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache", "winCodeSign");
const target = join(cache, "winCodeSign-2.6.0");

if (!existsSync(cache) || existsSync(target)) process.exit(0);
const src = readdirSync(cache).find((d) => {
  const p = join(cache, d);
  return /^\d+$/.test(d) && statSync(p).isDirectory() && existsSync(join(p, "rcedit-x64.exe"));
});
if (src) {
  cpSync(join(cache, src), target, { recursive: true });
  console.log(`[fix-wincodesign] ${src} -> winCodeSign-2.6.0`);
}
