/** A private, versioned Node host for Pi. Only explicit runtime installation
 * downloads it; discovery and app startup must stay read-only/offline. */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, chmod, stat, access, readdir, rmdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

export const MANAGED_NODE_VERSION = "24.21.0";
const run = promisify(execFile);
const pending = new Map<string, Promise<string>>();
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

export function managedNodeExecutable(root: string): string {
  return join(root, "node", MANAGED_NODE_VERSION,
    ...(process.platform === "win32" ? ["node.exe"] : ["bin", "node"]));
}

export function managedNpmCli(root: string): string {
  return join(root, "node", MANAGED_NODE_VERSION,
    ...(process.platform === "win32" ? ["node_modules"] : ["lib", "node_modules"]),
    "npm", "bin", "npm-cli.js");
}

async function validInstalledNode(file: string): Promise<boolean> {
  try {
    const result = await run(file, ["--version"], {
      timeout: 8000, windowsHide: true, maxBuffer: 4096,
    });
    return result.stdout.trim() === `v${MANAGED_NODE_VERSION}`;
  } catch { return false; }
}

/** Share concurrent explicit installs; never touch external Node installs. */
export function ensureManagedNodeRuntime(root: string): Promise<string> {
  const key = resolve(root);
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = installNode(key).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

async function installNode(root: string): Promise<string> {
  const executable = managedNodeExecutable(root);
  if (await validInstalledNode(executable)) {
    try { await access(managedNpmCli(root)); return executable; } catch { /* repair incomplete tools */ }
  }
  if (!["win32", "darwin", "linux"].includes(process.platform) ||
      !["x64", "arm64"].includes(process.arch)) {
    throw new Error(`Managed Node is unavailable for ${process.platform}/${process.arch}. Select a local Node >=22.19.`);
  }
  const platform = process.platform === "win32" ? "win" : process.platform;
  const archiveRoot = `node-v${MANAGED_NODE_VERSION}-${platform}-${process.arch}`;
  const artifact = process.platform === "win32"
    ? `${archiveRoot}.zip` : `${archiveRoot}.tar.gz`;
  const base = `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/`;
  const metadata = await fetch(`${base}SHASUMS256.txt`, { signal: AbortSignal.timeout(20000) });
  if (!metadata.ok) throw new Error(`Node checksums download failed: HTTP ${metadata.status}`);
  const sums = await metadata.text();
  const match = sums.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
    .find((parts) => parts.length === 2 && parts[1] === artifact);
  if (!match || !/^[a-f0-9]{64}$/i.test(match[0])) {
    throw new Error(`Official Node checksum missing for ${artifact}`);
  }
  const parent = join(root, "node");
  const staging = join(parent, `.staging-${randomUUID()}`);
  const target = join(parent, MANAGED_NODE_VERSION);
  const backup = join(parent, `.backup-${randomUUID()}`);
  // All destructive targets are our explicitly allocated children of node/.
  for (const dir of [staging, target, backup]) {
    if (!resolve(dir).startsWith(resolve(parent) + sep)) throw new Error("Invalid Node install path");
  }
  await mkdir(staging, { recursive: true });
  let swapped = false;
  let backedUp = false;
  try {
    const download = join(staging, process.platform === "win32" ? "node.zip" : "node.tar.gz");
    const response = await fetch(`${base}${artifact}`, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`Node download failed: HTTP ${response.status}`);
    const digest = createHash("sha256");
    let received = 0;
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) return callback(new Error("Node download exceeds size limit"));
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), verifier, createWriteStream(download));
    if (digest.digest("hex") !== match[0].toLowerCase()) throw new Error("Node SHA-256 checksum mismatch");
    if (process.platform === "win32") {
      // Windows includes PowerShell. Pass paths as environment values, never
      // interpolate them into shell source (spaces/non-ASCII/quotes are safe).
      await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:MARIO_NODE_ARCHIVE -DestinationPath $env:MARIO_NODE_STAGE"], {
        timeout: 120000, windowsHide: true, maxBuffer: 8192,
        env: { ...process.env, MARIO_NODE_ARCHIVE: download, MARIO_NODE_STAGE: staging },
      });
      const extracted = join(staging, archiveRoot);
      for (const name of await readdir(extracted)) await rename(join(extracted, name), join(staging, name));
      await rmdir(extracted);
      await rm(download);
    } else {
      const { extract } = await import("tar");
      // Keep Node and the official bundled npm dependency closure; do not
      // unpack symlinks or unrelated paths from the verified distribution.
      await extract({
        file: download, cwd: staging, strip: 1, strict: true,
        filter: (path, entry) => !path.split("/").includes("..") && "type" in entry
          && (entry.type === "File" || entry.type === "Directory")
          && (path === `${archiveRoot}/bin/node` || path === `${archiveRoot}/LICENSE`
            || path.startsWith(`${archiveRoot}/lib/node_modules/npm/`)),
      });
      await rm(download);
      await chmod(join(staging, "bin", "node"), 0o755);
    }
    const stagedExecutable = join(staging, ...(process.platform === "win32" ? ["node.exe"] : ["bin", "node"]));
    if (!await validInstalledNode(stagedExecutable)) throw new Error("Downloaded Node failed its version probe");
    const stagedNpm = join(staging, ...(process.platform === "win32" ? ["node_modules"] : ["lib", "node_modules"]), "npm", "bin", "npm-cli.js");
    const npmProbe = await run(stagedExecutable, [stagedNpm, "--version"], { timeout: 10000, windowsHide: true, maxBuffer: 8192 });
    if (!/^\d+\.\d+\.\d+/.test(npmProbe.stdout.trim())) throw new Error("Managed npm failed its version probe");
    try { await stat(target); backedUp = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (backedUp) await rename(target, backup);
    try {
      await rename(staging, target);
      swapped = true;
    } catch (error) {
      if (backedUp) await rename(backup, target);
      throw error;
    }
    if (backedUp) await rm(backup, { recursive: true, force: true });
    return executable;
  } finally {
    if (!swapped) await rm(staging, { recursive: true, force: true });
  }
}
