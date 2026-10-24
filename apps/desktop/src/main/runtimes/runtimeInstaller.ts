/**
 * Download-on-demand installer for the agent runtimes (claude / codex / pi).
 *
 * The big native payloads (claude.exe ~209MB, codex vendor tree ~378MB) and
 * the pi JS library with its dependency tree (~44MB) are NOT shipped inside
 * the installer — they are downloaded from the npm registry on demand and
 * unpacked under `<userData>/runtimes/<agent>/<version>/`. The resolvers
 * (sdkBinaryPath / codexBinaryResolve / piSdkLoader) look there FIRST, so a
 * successful install is immediately visible to the providers; a missing
 * runtime surfaces as a friendly "not installed" error that points at the
 * settings panel.
 *
 * Sources (same artifacts `npm install` would fetch — no new trust origin):
 *  - claude: @anthropic-ai/claude-agent-sdk-<platform>-<arch>@<expected>
 *      (dep-free tarball, binary at package root: claude[.exe])
 *  - codex:  @openai/codex@<expected>-<platform>-<arch>
 *      (dep-free tarball, binary under vendor/<triple>/bin/codex[.exe])
 *  - pi:     the official @earendil-works/pi-coding-agent@<expected> (pinned
 *      in package.json), installed with MarioCode's private managed npm into
 *      a flat node_modules closure (assemblePiClosureWithNpm; npm verifies
 *      each package's integrity). There is no prepacked registry package;
 *      build/pack-pi-runtime.cjs produces the same layout for offline
 *      install-from-file.
 *
 * Every install is atomic: download to a temp file (sha512-verified against
 * the registry's dist.integrity), extract into a staging dir, verify the
 * expected payload exists, then rename into place and prune older versions.
 * Progress is pushed to the renderer over `runtimes:event`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { app } from "electron";
import {
  IPC,
  type RuntimeAgentId,
  type RuntimeAgentState,
  type RuntimeProgressPayload,
} from "@contracts/ipc";
import { sendToRenderer } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { getManagedRuntimeRoot, listManagedVersions } from "./managedRuntimeRoots.js";
import { hasRunningTurn } from "./runtimeMutation.js";
import { codexVendorTriple, findCodexBinaryInPackage } from "@main/providers/codex-sdk/codexBinaryResolve.js";
import {
  brokenManagedPayloads,
  installedManagedPayload,
  payloadEntryPath,
  probeRuntimeAvailability,
  type RuntimeSource,
} from "./runtimeAvailability.js";
import { MIN_PLAUSIBLE_BINARY_BYTES, payloadPlatformMatches } from "./payloadGuard.js";
import {
  compareCoreVersions,
  discoverExternalRuntimes,
  getRuntimeSelection,
  newestTooOld,
} from "./runtimeSelection.js";
import { ensureManagedNodeRuntime, managedNpmCli } from "./managedNodeRuntime.js";

/** Used when this app's package.json can't be read (shouldn't happen — it
 *  ships inside the asar and exists in dev). Keep in sync with package.json. */
const FALLBACK_VERSIONS: Record<RuntimeAgentId, string> = {
  claude: "0.3.304",
  codex: "0.153.4",
  pi: "0.83.0",
};

/** npmmirror first (CN-friendly, same metadata + integrity as official);
 *  official registry as the fallback. */
const REGISTRIES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"] as const;

const META_TIMEOUT_MS = 15_000;
const LATEST_TIMEOUT_MS = 6_000;

/** A plain release version. Registry responses and package metadata are
 *  untrusted until they pass this: the string is later joined into a staging
 *  path and interpolated into registry URLs and an npm spec. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export function isReleaseVersion(value: string): boolean {
  return RELEASE_VERSION.test(value);
}
const LATEST_TTL_MS = 10 * 60_000;
const DISK_TTL_MS = 30_000;
const PROGRESS_EMIT_INTERVAL_MS = 150;
/** Safety cap for the local `npm install` pi assembly (140-package closure on
 *  a slow mirror can take minutes; a hung npm must not wedge the panel's
 *  installing state forever). */
const PI_NPM_ASSEMBLE_TIMEOUT_MS = 10 * 60_000;

/* ── expected versions (from this app's package.json) ── */

let expectedVersions: Record<RuntimeAgentId, string> | null = null;

function loadExpectedVersions(): Record<RuntimeAgentId, string> {
  if (expectedVersions) return expectedVersions;
  const out: Record<RuntimeAgentId, string> = { ...FALLBACK_VERSIONS };
  try {
    const raw = readFileSync(join(app.getAppPath(), "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    // Strip range prefixes (^ ~ >=) — package.json pins exact versions for
    // all three, but be defensive.
    const pin = (name: string, key: RuntimeAgentId) => {
      const v = deps[name];
      if (typeof v === "string" && v.length > 0) out[key] = v.replace(/^[\^~>=<\s]+/, "");
    };
    pin("@anthropic-ai/claude-agent-sdk", "claude");
    pin("@openai/codex", "codex");
    pin("@earendil-works/pi-coding-agent", "pi");
  } catch {
    // keep fallbacks
  }
  expectedVersions = out;
  return out;
}

/** The npm package + exact version to download for one agent. */
function npmPackageFor(agent: RuntimeAgentId, version: string): { name: string; version: string } {
  const plat = `${process.platform}-${process.arch}`;
  switch (agent) {
    case "claude":
      return { name: `@anthropic-ai/claude-agent-sdk-${plat}`, version };
    case "codex":
      // Platform builds are published as versions of the SAME package:
      // @openai/codex@0.153.4-win32-x64 (the wrapper's optionalDependencies
      // alias these). See codexBinaryResolve.ts for the layout.
      return { name: "@openai/codex", version: `${version}-${plat}` };
    case "pi":
      // Not a single tarball: the official package's dependency closure is
      // assembled locally with the managed npm (assemblePiClosureWithNpm).
      return { name: "@earendil-works/pi-coding-agent", version };
  }
}

/** The package whose "latest" dist-tag reflects the upstream version for an
 *  agent. For codex this is the wrapper (its latest is the bare semver, while
 *  platform builds carry `<semver>-<plat>` versions). */
function latestCheckPackageFor(agent: RuntimeAgentId): string {
  switch (agent) {
    case "claude":
      return `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    case "codex":
      return "@openai/codex";
    case "pi":
      return "@earendil-works/pi-coding-agent";
  }
}

/* ── payload layouts (what a good extraction must contain) ──
 *  payloadEntryPath / installedManagedPayload live in runtimeAvailability.ts
 *  so the settings panel can probe the SAME layout definition. */

/* ── module state ── */

const installing = new Map<RuntimeAgentId, boolean>();
const lastErrors = new Map<RuntimeAgentId, string>();
const latestCache = new Map<RuntimeAgentId, { version: string | null; at: number }>();
const diskCache = new Map<string, { bytes: number; at: number }>();

function emitProgress(
  agent: RuntimeAgentId,
  phase: RuntimeProgressPayload["phase"],
  progress: number,
  error?: string,
): void {
  const payload: RuntimeProgressPayload = { agent, phase, progress };
  if (error) payload.error = error;
  try {
    sendToRenderer(IPC.RUNTIMES_EVENT, { channel: IPC.RUNTIMES_EVENT, payload });
  } catch {
    // no window yet — progress is best-effort
  }
}

/* ── registry access ── */

function registryPath(name: string): string {
  return name.replace("/", "%2F");
}

async function fetchPackageMeta(
  name: string,
  version: string,
): Promise<{ tarballUrl: string; integrity: string } | null> {
  for (const reg of REGISTRIES) {
    try {
      const res = await fetch(`${reg}/${registryPath(name)}/${version}`, {
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const manifest = (await res.json()) as {
        dist?: { tarball?: string; integrity?: string };
      };
      if (!manifest.dist?.tarball) continue;
      return { tarballUrl: manifest.dist.tarball, integrity: manifest.dist.integrity ?? "" };
    } catch {
      continue;
    }
  }
  return null;
}

/** Best-effort "latest" lookup; returns null when both registries fail. */
async function fetchLatestVersion(agent: RuntimeAgentId): Promise<string | null> {
  const name = latestCheckPackageFor(agent);
  for (const reg of REGISTRIES) {
    try {
      const res = await fetch(`${reg}/${registryPath(name)}/latest`, {
        signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const manifest = (await res.json()) as { version?: string };
      if (typeof manifest.version === "string" && isReleaseVersion(manifest.version)) return manifest.version;
    } catch {
      continue;
    }
  }
  return null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return await Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/* ── download + extract ── */

async function downloadVerifiedTarball(
  agent: RuntimeAgentId,
  meta: { tarballUrl: string; integrity: string },
): Promise<string> {
  if (!meta.integrity) {
    throw new Error("registry metadata has no dist.integrity — refusing to install an unverifiable artifact");
  }
  const res = await fetch(meta.tarballUrl, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`tarball download failed: HTTP ${res.status} for ${meta.tarballUrl}`);
  }
  const total = Number(res.headers.get("content-length") ?? 0);
  const hash = createHash("sha512");
  const tmpFile = join(tmpdir(), `mariocode-runtime-${agent}-${Date.now()}.tgz`);
  let received = 0;
  let lastEmit = 0;
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeWebReadableStream),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk);
          received += chunk.byteLength;
          const now = Date.now();
          if (total > 0 && now - lastEmit > PROGRESS_EMIT_INTERVAL_MS) {
            lastEmit = now;
            emitProgress(agent, "downloading", Math.min(received / total, 1));
          }
          yield chunk;
        }
      },
      createWriteStream(tmpFile),
    );
  } catch (err) {
    rmSync(tmpFile, { force: true });
    throw new Error(
      `tarball download failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const computed = `sha512-${hash.digest("base64")}`;
  if (computed !== meta.integrity) {
    rmSync(tmpFile, { force: true });
    throw new Error(`sha512 mismatch for ${meta.tarballUrl} (expected ${meta.integrity}, got ${computed})`);
  }
  return tmpFile;
}

/* ── disk helpers ── */

/** Assemble the pi dependency closure LOCALLY with npm — the one and only
 *  online install path for pi (the official package, no prepacked
 *  meta-package). Identical recipe to build/pack-pi-runtime.cjs: a real npm
 *  install hoists the closure into `<stagingDir>/node_modules` (npm verifies
 *  each package's integrity itself; --ignore-scripts keeps it hermetic — no
 *  postinstall of any transitive dep runs). Produces exactly the layout
 *  `payloadEntryPath("pi", ...)` asserts. */
async function assemblePiClosureWithNpm(stagingDir: string, version: string, runtimeRoot: string): Promise<void> {
  writeFileSync(
    join(stagingDir, "package.json"),
    JSON.stringify({ name: "mariocode-pi-runtime", version, private: true }, null, 2) + "\n",
  );
  // Use the private managed toolchain only. Calling npm through Node avoids
  // .cmd/shell semantics on Windows and never depends on or mutates a user's
  // global Node/npm installation.
  const nodePath = await ensureManagedNodeRuntime(runtimeRoot);
  const npmCli = managedNpmCli(runtimeRoot);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      nodePath,
      [
        npmCli,
        "install",
        `@earendil-works/pi-coding-agent@${version}`,
        "--global=false",
        `--prefix=${stagingDir}`,
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        "--no-save",
      ],
      { cwd: stagingDir, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    // Keep only the tail — npm error context lives at the end, and a garbled
    // CN codepage flood shouldn't grow this without bound.
    let output = "";
    const append = (chunk: Buffer | string): void => {
      output += chunk.toString();
      if (output.length > 8_000) output = output.slice(-8_000);
    };
    const killTimer = setTimeout(() => child.kill(), PI_NPM_ASSEMBLE_TIMEOUT_MS);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(new Error(`managed npm spawn failed: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        resolve();
        return;
      }
      const tail = output.trim().split("\n").slice(-4).join(" | ");
      reject(new Error(`managed npm install exited ${code ?? "abnormally"}${tail ? `: ${tail}` : ""}`));
    });
  });
}

function dirSize(dir: string): number {
  let total = 0;
  const walk = (p: string): void => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (!st.isDirectory()) {
      total += st.size;
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) walk(join(p, entry));
  };
  walk(dir);
  return total;
}

function dirSizeCached(dir: string): number {
  const cached = diskCache.get(dir);
  if (cached && Date.now() - cached.at < DISK_TTL_MS) return cached.bytes;
  const bytes = dirSize(dir);
  diskCache.set(dir, { bytes, at: Date.now() });
  return bytes;
}

/* ── public API ── */

export function isRuntimeInstalling(agent: RuntimeAgentId): boolean {
  return installing.get(agent) ?? false;
}

/** Last auto-update attempt per agent. listRuntimes runs on every panel mount
 *  and progress push, so a failed attempt is retried at most this often. A
 *  successful update needs no entry: the next listRuntimes sees installed ==
 *  latest and returns early. */
const autoUpdateAttemptedAt = new Map<RuntimeAgentId, number>();
const AUTO_UPDATE_RETRY_MS = 30 * 60_000;

/** AUTO mode: the managed copy auto-updates to the registry's latest version
 *  in the background (TODO-057). Runs off the turn path from listRuntimes(),
 *  strictly best-effort: offline / failed checks and failed installs are
 *  logged and retried after AUTO_UPDATE_RETRY_MS. A failed install never
 *  disturbs the existing copy (finalizeInstall swaps atomically), and a
 *  background install never deletes older versions while a turn is running
 *  (see pruneOldVersions). */
function triggerAutoUpdate(agent: RuntimeAgentId, installedVersion: string | null): void {
  if (installing.get(agent)) return;
  if (installedVersion === null) return; // nothing installed — the panel's install button covers that
  const latest = latestCache.get(agent)?.version ?? null;
  if (!latest) return; // offline / latest check failed — skip silently
  if (compareCoreVersions(installedVersion, latest) >= 0) return; // already current
  const last = autoUpdateAttemptedAt.get(agent);
  if (last !== undefined && Date.now() - last < AUTO_UPDATE_RETRY_MS) return;
  autoUpdateAttemptedAt.set(agent, Date.now());
  log.info(`runtime auto-update: ${agent} ${installedVersion} -> ${latest} (background)`);
  void installRuntime(agent, latest).then((result) => {
    if (!result.ok) {
      log.warn(`runtime auto-update failed (${agent}): ${result.error ?? "unknown"}`);
    }
  });
}

export async function listRuntimes(): Promise<RuntimeAgentState[]> {
  const expected = loadExpectedVersions();
  const agents: RuntimeAgentId[] = ["claude", "codex", "pi"];
  // Best-effort latest-version refresh (bounded so an offline panel still
  // paints immediately).
  await Promise.all(
    agents.map(async (agent) => {
      const cached = latestCache.get(agent);
      if (cached && Date.now() - cached.at < LATEST_TTL_MS) return;
      const version = await withTimeout(fetchLatestVersion(agent), LATEST_TIMEOUT_MS + 2_000);
      latestCache.set(agent, { version, at: Date.now() });
    }),
  );
  return await Promise.all(agents.map(async (agent) => {
    const selection = getRuntimeSelection(agent);
    const managed = installedManagedPayload(agent);
    const installedVersion = managed?.version ?? null;
    if (selection.mode === "auto") triggerAutoUpdate(agent, installedVersion);
    // Local installations are probed for the panel's info display only —
    // since TODO-057 no resolver ever loads from them.
    const candidates = await discoverExternalRuntimes(agent);
    // Effective source: managed first, else the fallback the resolvers would
    // use (dev node_modules / legacy bundled). The panel displays THIS — a
    // dev checkout must not read "not installed" while every agent works.
    const fallback = managed ? null : probeRuntimeAvailability(agent);
    // Newest too-old detected install, but only when no usable local
    // candidate exists (a newer one being shown makes it moot). Info only.
    const localTooOld = candidates.some((candidate) => candidate.available)
      ? null
      : newestTooOld(candidates);
    const activeVersion = managed?.version ?? fallback?.version ?? null;
    const source: RuntimeSource | null = managed ? "managed" : fallback?.source ?? null;
    const available = source !== null;
    // A downloaded copy that exists but cannot launch (truncated or a binary
    // for another OS) is otherwise invisible here: the panel would claim
    // "nothing available" while a broken install sits on disk, and the SDK
    // would blame the C library when a turn starts. Name the real problem.
    const broken = available ? [] : brokenManagedPayloads(agent);
    const diagnostic = available
      ? "Managed runtime selection is available."
      : broken.length > 0
        ? `已下载的运行时文件不完整(${agent} ${broken[0].version}${broken[0].size >= 0 ? `,只有 ${broken[0].size} 字节` : ""}),请重新安装(the downloaded payload is incomplete — reinstall to re-download)`
        : "No managed, development, or bundled runtime is available.";
    return {
      agent,
      selectedMode: selection.mode,
      configuredPath: selection.path,
      configuredNodePath: selection.nodePath,
      expectedVersion: expected[agent],
      installedVersion,
      source,
      activeVersion,
      activePath: managed?.entry ?? fallback?.path ?? null,
      available,
      compatibility: available ? "unknown" : "incompatible",
      diagnostic,
      candidates,
      localTooOld,
      latestVersion: latestCache.get(agent)?.version ?? null,
      installed: managed !== null,
      // The ACTIVE copy differs from the version this MarioCode build
      // expects. Managed mode surfaces a badge; auto mode self-heals via
      // the background auto-update to latest, so it doesn't nag.
      // Only OLDER than the build-pinned version counts: an auto-updated copy
      // is newer than `expected`, and offering "update" there would downgrade.
      updateAvailable: selection.mode === "managed"
        && activeVersion !== null && compareCoreVersions(activeVersion, expected[agent]) < 0,
      installing: installing.get(agent) ?? false,
      lastError: lastErrors.get(agent) ?? "",
      diskBytes: managed ? dirSizeCached(managed.dir) : 0,
      installPath: managed?.entry ?? null,
    };
  }));
}

/** Shared tail of both install paths: verify the extracted payload, fix
 *  binary permissions, atomically move staging into place, write the install
 *  record and prune other versions. Throws on layout mismatch; on success the
 *  caller must NOT clean up stagingDir anymore (it was renamed). */
/** Delete every managed version of `agent` except `keep`. Skipped while any
 *  session has a running turn: that turn may be executing from (or about to
 *  spawn from) an older directory, and on Windows a locked exe makes the
 *  delete fail halfway, leaving a broken copy. Skipped prunes are retried by
 *  sweepManagedRuntimes() once the app is idle. Only strict semver directory
 *  names are touched — never node/, staging or backup dirs. */
function pruneOldVersions(agent: RuntimeAgentId, keep: string): void {
  if (hasRunningTurn()) return;
  const root = getManagedRuntimeRoot() ?? join(app.getPath("userData"), "runtimes");
  for (const other of listManagedVersions(agent)) {
    if (other === keep || !isReleaseVersion(other)) continue;
    try {
      rmSync(join(root, agent, other), { recursive: true, force: true });
    } catch (error) {
      log.warn(`runtime prune: could not remove ${agent}/${other}: ${String(error)}`);
    }
  }
}

/** Idle-time cleanup: drop superseded versions that an earlier install could
 *  not prune (a turn was running), and leftovers of interrupted installs
 *  (`.x.staging-*`, `x.backup-*`). Never runs while an install for the agent
 *  is in flight (its staging dir is live) or while a turn is running. */
export function sweepManagedRuntimes(): void {
  if (hasRunningTurn()) return;
  const root = getManagedRuntimeRoot();
  if (!root) return;
  for (const agent of ["claude", "codex", "pi"] as const) {
    if (installing.get(agent)) continue;
    const newest = listManagedVersions(agent)[0];
    if (newest) pruneOldVersions(agent, newest);
    let entries: string[] = [];
    try { entries = readdirSync(join(root, agent)); } catch { continue; }
    for (const entry of entries) {
      if (!/^\.[^/\\]+\.staging-\d+$/.test(entry) && !/\.backup-\d+-\d+$/.test(entry)) continue;
      try {
        rmSync(join(root, agent, entry), { recursive: true, force: true });
      } catch (error) {
        log.warn(`runtime sweep: could not remove ${agent}/${entry}: ${String(error)}`);
      }
    }
  }
}

function finalizeInstall(
  agent: RuntimeAgentId,
  stagingDir: string,
  version: string,
  record: { npmName?: string; source: "registry" | "local-path"; localPath?: string },
): { finalDir: string; entry: string } {
  // Version comes from local package metadata as well as the registry. It
  // must never be interpreted as a filesystem path during swap/cleanup.
  if (!isReleaseVersion(version)) {
    throw new Error(`Invalid runtime version: ${version}`);
  }
  const entry = payloadEntryPath(agent, stagingDir);
  if (!entry || !existsSync(entry)) {
    throw new Error(`extracted archive but the expected payload is missing — wrong package for "${agent}", or the upstream layout changed?`);
  }
  if (process.platform !== "win32" && agent !== "pi") {
    // node-tar preserves the tarball's modes, but be defensive: the binary
    // must be executable for spawn.
    try {
      chmodSync(entry, 0o755);
    } catch {
      // best-effort
    }
  }
  // Payload sanity check BEFORE the swap. A torn/truncated extraction, or a
  // tarball carrying a binary for another OS, passes existsSync everywhere yet
  // cannot launch — and the Agent SDK reports that as an unrelated "binary
  // does not match this system's libc" error (see payloadGuard.ts). Refusing
  // here leaves the previous working version in place instead of replacing it
  // with a copy that will fail at every turn start.
  if (agent !== "pi") {
    let size = -1;
    try {
      size = statSync(entry).size;
    } catch {
      size = -1;
    }
    if (size >= 0 && size < MIN_PLAUSIBLE_BINARY_BYTES) {
      throw new Error(
        `installed ${agent}@${version} but the binary is only ${size} bytes — the download was truncated; please retry the install`,
      );
    }
    if (!payloadPlatformMatches(entry)) {
      throw new Error(
        `installed ${agent}@${version} but the binary is not a ${process.platform} executable — the registry/mirror served a package for another platform; please retry, or install from a local copy`,
      );
    }
  }
  const root = getManagedRuntimeRoot() ?? join(app.getPath("userData"), "runtimes");
  const finalDir = join(root, agent, version);
  writeFileSync(
    join(stagingDir, "install.json"),
    JSON.stringify({ agent, version, installedAt: new Date().toISOString(), ...record }, null, 2),
  );
  // Swap with rollback: never destroy the working version before the fully
  // verified staging tree is in place. The backup is under this agent's
  // managed directory and is removed only after the rename succeeds.
  const backupDir = `${finalDir}.backup-${Date.now()}-${process.pid}`;
  let backedUp = false;
  try {
    if (existsSync(finalDir)) {
      renameSync(finalDir, backupDir);
      backedUp = true;
    }
    renameSync(stagingDir, finalDir);
  } catch (error) {
    if (backedUp && !existsSync(finalDir) && existsSync(backupDir)) {
      try { renameSync(backupDir, finalDir); }
      catch (rollbackError) {
        throw new Error(`runtime swap failed and rollback also failed: ${String(error)}; rollback: ${String(rollbackError)}`);
      }
    }
    throw error;
  }
  // The new copy is in place; everything below is housekeeping and must never
  // turn a completed install into a reported failure (a locked file on
  // Windows makes rmSync throw, but the swap already succeeded).
  if (backedUp) {
    try { rmSync(backupDir, { recursive: true, force: true }); }
    catch (error) { log.warn(`runtime install: could not remove ${backupDir}: ${String(error)}`); }
  }
  pruneOldVersions(agent, version);
  const finalEntry = payloadEntryPath(agent, finalDir);
  if (!finalEntry) throw new Error(`installed runtime payload disappeared after swap: ${finalDir}`);
  return { finalDir, entry: finalEntry };
}

/** Version dir name for an installed runtime. The codex platform package
 *  publishes its version WITH the platform suffix (0.153.4-win32-x64) —
 *  normalize to the bare semver so updateAvailable compares against the
 *  expected version correctly. */
function normalizeInstalledVersion(agent: RuntimeAgentId, version: string): string {
  if (agent === "codex") {
    const suffix = `-${process.platform}-${process.arch}`;
    if (version.endsWith(suffix)) return version.slice(0, -suffix.length);
  }
  return version;
}

/** Read the version out of an extracted npm-shaped package root (package.json
 *  at staging root). Falls back to `fallback` when unreadable. */
function extractedVersion(stagingDir: string, fallback: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(stagingDir, "package.json"), "utf8")) as {
      version?: string;
    };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    // keep fallback
  }
  return fallback;
}

/** Download + install (or update / reinstall) one runtime. Resolves when the
 *  install fully finished (or failed — check `ok`/`error`). Without a
 *  `version` the build-pinned expected version is installed; pass an explicit
 *  version (e.g. the registry's latest) for update / auto-update flows. */
export async function installRuntime(
  agent: RuntimeAgentId,
  version?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (installing.get(agent)) {
    return { ok: false, error: `runtime ${agent} is already being installed` };
  }
  installing.set(agent, true);
  lastErrors.set(agent, "");
  let stagingDir: string | null = null;
  emitProgress(agent, "downloading", -1);
  try {
    const target = (version ?? loadExpectedVersions()[agent]).trim();
    // Validate before the string reaches a URL, an npm spec or a staging path.
    if (!isReleaseVersion(target)) throw new Error(`Invalid runtime version: ${target}`);
    const pkg = npmPackageFor(agent, target);
    // pi has no prepacked tarball: skip the registry lookup and always
    // assemble the official package's closure locally with the managed npm.
    const meta = agent === "pi" ? null : await fetchPackageMeta(pkg.name, pkg.version);
    if (!meta && agent !== "pi") {
      throw new Error(
        `registry has no ${pkg.name}@${pkg.version} — check the network/mirror, or the version hasn't been published yet`,
      );
    }
    if (meta) {
      log.info(`runtime install: ${agent} downloading ${pkg.name}@${pkg.version}`);
      const tmpTarball = await downloadVerifiedTarball(agent, meta);
      try {
        emitProgress(agent, "extracting", -1);
        const root = getManagedRuntimeRoot() ?? join(app.getPath("userData"), "runtimes");
        stagingDir = join(root, agent, `.${target}.staging-${Date.now()}`);
        mkdirSync(stagingDir, { recursive: true });
        const { extract } = await import("tar");
        // npm tarballs root everything under package/ — strip that prefix.
        await extract({ file: tmpTarball, cwd: stagingDir, strip: 1 });
        // Guard against a truncated/torn extraction: if the expected payload
        // isn't there, fail NOW and leave staging for the finally-cleaner —
        // never let finalizeInstall swap a partial tree into place (a swap
        // that half-fails leaves the entry file present but the rest of the
        // payload missing, and resolvers then spawn a broken binary).
        const stagedEntry = payloadEntryPath(agent, stagingDir);
        if (!stagedEntry || !existsSync(stagedEntry)) {
          throw new Error(
            `extracted ${pkg.name}@${pkg.version} but the expected payload is missing — download was likely interrupted; please retry the install`,
          );
        }
      } finally {
        rmSync(tmpTarball, { force: true });
      }
    } else {
      // pi: install @earendil-works/pi-coding-agent@<target> with the
      // managed npm into the staging dir (flat node_modules closure).
      emitProgress(agent, "downloading", -1);
      const root = getManagedRuntimeRoot() ?? join(app.getPath("userData"), "runtimes");
      stagingDir = join(root, agent, `.${target}.staging-${Date.now()}`);
      mkdirSync(stagingDir, { recursive: true });
      log.info(`runtime install: pi assembling ${pkg.name}@${target} with managed npm`);
      try {
        await assemblePiClosureWithNpm(stagingDir, target, root);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `installing ${pkg.name}@${pkg.version} with npm failed (${reason}) — ` +
            `check the network/managed tools, or pack locally with \`pnpm pack:pi-runtime\` and use install-from-file`,
        );
      }
    }

    if (agent === "pi") {
      await ensureManagedNodeRuntime(getManagedRuntimeRoot() ?? join(app.getPath("userData"), "runtimes"));
    }
    const { finalDir } = finalizeInstall(agent, stagingDir, target, {
      npmName: pkg.name,
      source: "registry",
    });
    stagingDir = null;
    lastErrors.set(agent, "");
    emitProgress(agent, "done", 1);
    log.info(`runtime installed: ${agent}@${target} -> ${finalDir}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastErrors.set(agent, msg);
    emitProgress(agent, "error", 0, msg);
    log.error(`runtime install failed (${agent}): ${msg}`);
    return { ok: false, error: msg };
  } finally {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
    installing.set(agent, false);
  }
}

/** Install a runtime from a user-picked LOCAL PATH — the escape hatch when
 *  the online path fails (npm/mirror unreachable, stale mirror, offline).
 *  Accepted, per agent:
 *   - claude: a directory containing claude[.exe] at its root (the platform
 *     package layout), or the binary file itself;
 *   - codex:  a directory with the vendored layout (vendor/<triple>/bin or
 *     legacy codex/), or the binary file itself (sandbox/code-mode helpers
 *     won't come along — advanced);
 *   - pi:     the packed meta-package directory (contains
 *     node_modules/@earendil-works/pi-coding-agent, i.e. what
 *     `pnpm pack:pi-runtime` stages), or the pi package dir itself;
 *   - any agent: an npm-shaped .tgz (previous install-from-file behavior).
 * The version is taken from the copied package.json when available, else the
 * expected version. No integrity check beyond the payload assertion — the
 * user hand-picked the path. */
export async function installRuntimeFromLocalPath(
  agent: RuntimeAgentId,
  localPath: string,
): Promise<{ ok: boolean; error?: string; version?: string }> {
  if (installing.get(agent)) {
    return { ok: false, error: `runtime ${agent} is already being installed` };
  }
  let st;
  try {
    st = statSync(localPath);
  } catch {
    return { ok: false, error: `path not found: ${localPath}` };
  }
  installing.set(agent, true);
  lastErrors.set(agent, "");
  let stagingDir: string | null = null;
  emitProgress(agent, "extracting", -1);
  try {
    const root = getManagedRuntimeRoot() ?? join(app.getPath("userData"), "runtimes");
    stagingDir = join(root, agent, `.local.staging-${Date.now()}`);
    mkdirSync(stagingDir, { recursive: true });

    if (st.isFile()) {
      if (/\.(tgz|tar\.gz)$/i.test(localPath)) {
        const { extract } = await import("tar");
        await extract({ file: localPath, cwd: stagingDir, strip: 1 });
      } else {
        installSingleBinary(agent, localPath, stagingDir);
      }
    } else {
      const layout = detectLocalDirLayout(agent, localPath);
      if (layout === null) {
        throw new Error(
          `该目录不包含可识别的 ${agent} 安装结构 — 请选择安装目录或 .tgz 包(no recognizable ${agent} install layout in that directory)`,
        );
      }
      if (layout === "pi-package") {
        cpSync(localPath, join(stagingDir, "node_modules", "@earendil-works", "pi-coding-agent"), {
          recursive: true,
        });
      } else {
        cpSync(localPath, stagingDir, { recursive: true });
      }
      // Same payload assertion as the registry path — a picked directory can
      // match the layout sniff yet still miss the real payload (e.g. a dir
      // containing a claude binary at the root but nothing else the agent
      // needs, or a codex dir whose vendored triple isn't this machine's).
      const stagedEntry = payloadEntryPath(agent, stagingDir);
      if (!stagedEntry || !existsSync(stagedEntry)) {
        throw new Error(
          `所选目录缺少 ${agent} 运行所需的完整文件(the picked directory is missing the full ${agent} payload — expected ${stagedEntry ?? "the payload entry"})`,
        );
      }
    }

    const version = normalizeInstalledVersion(
      agent,
      extractedVersion(stagingDir, loadExpectedVersions()[agent]),
    );
    if (agent === "pi") {
      await ensureManagedNodeRuntime(getManagedRuntimeRoot() ?? join(app.getPath("userData"), "runtimes"));
    }
    const { finalDir } = finalizeInstall(agent, stagingDir, version, {
      source: "local-path",
      localPath,
    });
    stagingDir = null;
    lastErrors.set(agent, "");
    emitProgress(agent, "done", 1);
    log.info(`runtime installed from local path: ${agent}@${version} (${localPath}) -> ${finalDir}`);
    return { ok: true, version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastErrors.set(agent, msg);
    emitProgress(agent, "error", 0, msg);
    log.error(`runtime install-from-local-path failed (${agent}): ${msg}`);
    return { ok: false, error: msg };
  } finally {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
    installing.set(agent, false);
  }
}

/** What a picked DIRECTORY looks like, per agent:
 *  - "package-dir": copy the whole directory into the managed version dir
 *    (claude platform package / codex vendored package / pi meta-package);
 *  - "pi-package": the pi package itself — place it under
 *    node_modules/@earendil-works/pi-coding-agent in the staging root;
 *  - null: unrecognized. */
function detectLocalDirLayout(
  agent: RuntimeAgentId,
  dir: string,
): "package-dir" | "pi-package" | null {
  if (agent === "claude") {
    return existsSync(join(dir, "claude.exe")) || existsSync(join(dir, "claude"))
      ? "package-dir"
      : null;
  }
  if (agent === "codex") {
    return findCodexBinaryInPackage(dir) ? "package-dir" : null;
  }
  // pi: the packed meta-package root (node_modules inside) ...
  if (existsSync(join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"))) {
    return "package-dir";
  }
  // ... or the pi package itself (dist/ + package.json).
  if (existsSync(join(dir, "dist", "index.js"))) {
    return "pi-package";
  }
  return null;
}

/** Place a user-picked agent BINARY into the managed layout (claude: package
 *  root; codex: vendor/<triple>/bin/). */
function installSingleBinary(agent: RuntimeAgentId, file: string, stagingDir: string): void {
  const name = basename(file);
  if (agent === "pi") {
    throw new Error("pi 是 JS 库,请选择包含 node_modules 的安装目录或 .tgz 包(pi is a JS library — pick its install directory or .tgz)");
  }
  const expectedNames =
    agent === "claude"
      ? ["claude.exe", "claude"]
      : ["codex.exe", "codex"];
  if (!expectedNames.includes(name.toLowerCase())) {
    throw new Error(
      `"${name}" 不是 ${agent} 的可执行文件(is not the ${agent} executable — expected ${expectedNames.join(" / ")})`,
    );
  }
  let dest: string;
  if (agent === "claude") {
    dest = join(stagingDir, name);
  } else {
    // A single codex binary must land exactly where the resolver looks it up;
    // without a known triple the layout can never be found, so refuse here
    // rather than installing a copy that silently never loads.
    const triple = codexVendorTriple();
    if (!triple) {
      throw new Error(
        `当前平台(${process.platform}-${process.arch})没有对应的 codex 目录布局(this platform has no known codex vendor layout)`,
      );
    }
    dest = join(stagingDir, "vendor", triple, "bin", name);
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(file, dest);
}

/** Delete every installed version of one runtime. Callers enforce the
 *  running-turn guard (see ipc/runtimes.ts). */
export async function removeRuntime(agent: RuntimeAgentId): Promise<{ ok: boolean; error?: string }> {
  if (installing.get(agent)) {
    return { ok: false, error: `runtime ${agent} is being installed — wait for it to finish` };
  }
  const root = getManagedRuntimeRoot();
  if (!root) return { ok: false, error: "runtime directory not initialized yet" };
  const dir = join(root, agent);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
  diskCache.delete(dir);
  lastErrors.set(agent, "");
  log.info(`runtime removed: ${agent}`);
  return { ok: true };
}

/** Managed version of one agent, or null (fallback sources not counted). */
export function installedVersionOf(agent: RuntimeAgentId): string | null {
  return installedManagedPayload(agent)?.version ?? null;
}
