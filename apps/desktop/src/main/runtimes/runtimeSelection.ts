/** Product-level runtime source selection shared by status UI and providers.
 *
 * TODO-057: device detection was removed. The engines NEVER use a locally
 * detected installation; AUTO = managed copy → dev/bundled fallback, and the
 * managed copy auto-updates to the registry's latest version in the
 * background (see runtimeInstaller.ts). Local installations are still probed
 * and returned to the settings panel as INFO ONLY. External mode was removed
 * outright: a stored "external" selection degrades to "auto". */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_MIN_LOCAL_VERSIONS,
  type RuntimeAgentId,
  type RuntimeCandidate,
  type RuntimeLocalTooOld,
  type RuntimeMode,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { which } from "@main/lib/binaryResolve.js";
import { log } from "@main/lib/logger.js";
import { compareVersions, getManagedRuntimeRoot, listManagedVersions } from "./managedRuntimeRoots.js";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 2_500;
const CACHE_TTL_MS = 30_000;
const selectionKey = (agent: RuntimeAgentId): string => `runtime.selection.${agent}`;

export interface RuntimeSelection {
  mode: RuntimeMode;
  path: string | null;
  nodePath: string | null;
  verifiedVersion: string | null;
  payloadFingerprint: string | null;
  nodeFingerprint: string | null;
}

export interface ResolvedRuntime {
  /** "managed" = the on-demand install under userData/runtimes; "dev" /
   *  "bundled" = the fallback the resolvers use when no managed copy exists. */
  source: "managed" | "dev" | "bundled";
  path: string;
  version: string | null;
}

function parseMode(value: unknown): RuntimeMode {
  return value === "managed" ? value : "auto";
}

/** A missing row means the user never chose → AUTO. A stored row keeps its
 *  mode; an unknown mode string also reads as AUTO. A legacy "external" row
 *  (TODO-057 removed the mode) degrades to AUTO — the managed copy takes
 *  over transparently instead of breaking on the stored path. */
function readSelection(agent: RuntimeAgentId): RuntimeSelection {
  try {
    const raw = SettingRepo.get(selectionKey(agent));
    if (!raw) return emptySelection("auto");
    const value = JSON.parse(raw) as Partial<RuntimeSelection>;
    return {
      mode: parseMode(value.mode),
      path: typeof value.path === "string" && value.path.trim() ? value.path : null,
      nodePath: typeof value.nodePath === "string" && value.nodePath.trim() ? value.nodePath : null,
      verifiedVersion: typeof value.verifiedVersion === "string" ? value.verifiedVersion : null,
      payloadFingerprint: typeof value.payloadFingerprint === "string" ? value.payloadFingerprint : null,
      nodeFingerprint: typeof value.nodeFingerprint === "string" ? value.nodeFingerprint : null,
    };
  } catch {
    return emptySelection("auto");
  }
}

function emptySelection(mode: "auto" | "managed"): RuntimeSelection {
  return { mode, path: null, nodePath: null, verifiedVersion: null, payloadFingerprint: null, nodeFingerprint: null };
}

function fileFingerprint(path: string): string | null {
  try { const st = statSync(path); return `${st.size}:${st.mtimeMs}`; } catch { return null; }
}

export function getRuntimeSelection(agent: RuntimeAgentId): RuntimeSelection {
  return readSelection(agent);
}

export function saveRuntimeSelection(agent: RuntimeAgentId, selection: RuntimeSelection): void {
  SettingRepo.set(selectionKey(agent), JSON.stringify(selection));
  probeCache.delete(agent);
}

function canonical(path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(path);
  try { return realpathSync(absolute); } catch { return normalize(absolute); }
}

function unique(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of paths) {
    if (!value) continue;
    const path = canonical(value);
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (!seen.has(key)) { seen.add(key); out.push(path); }
  }
  return out;
}

/** Resolve npm .cmd shims to a native executable; never execute the shim. */
function nativeFromCmd(path: string, agent: "claude" | "codex"): string | null {
  if (process.platform !== "win32" || extname(path).toLowerCase() !== ".cmd") return path;
  const root = dirname(path);
  if (agent === "claude") {
    for (const p of [
      join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
      join(root, "node_modules", "@anthropic-ai", "claude-code", "claude.exe"),
    ]) if (existsSync(p)) return p;
  } else {
    for (const p of [
      join(root, "node_modules", "@openai", "codex", "vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe"),
      join(root, "node_modules", "@openai", "codex", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      join(root, "node_modules", "@openai", "codex", "codex", "codex.exe"),
    ]) if (existsSync(p)) return p;
  }
  return null;
}

function normalizeExternalPath(agent: RuntimeAgentId, path: string): string | null {
  const p = canonical(path);
  if (agent === "claude" || agent === "codex") return nativeFromCmd(p, agent);
  if (extname(p).toLowerCase() === ".cmd") {
    for (const scope of ["@earendil-works", "@mariozechner"]) {
      const candidate = join(dirname(p), "node_modules", scope, "pi-coding-agent", "package.json");
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
  const pkg = p.endsWith("package.json") ? p : join(p, "package.json");
  if (existsSync(pkg)) return pkg;
  // POSIX npm exposes `pi` as a symlink to dist/bundle/cli.js. Walk back to
  // the package root instead of assuming a fixed entry depth.
  let ancestor = existsSync(p) && extname(p) === ".js" ? dirname(p) : p;
  for (let i = 0; i < 6; i++) {
    const candidate = join(ancestor, "package.json");
    if (existsSync(candidate)) {
      try {
        const name = (JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown }).name;
        if (name === "@earendil-works/pi-coding-agent" || name === "@mariozechner/pi-coding-agent") return candidate;
      } catch { /* keep walking */ }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const nested = join(p, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  return existsSync(nested) ? nested : null;
}

/** Detected local install locations. These are probed for the panel's info
 *  display only — since TODO-057 no resolver ever loads from them. */
function externalPaths(agent: RuntimeAgentId): string[] {
  const appdata = process.env["APPDATA"] ?? "";
  const direct = agent === "claude"
    ? [which("claude"), join(appdata, "npm", "claude.cmd")]
    : agent === "codex"
      ? [which("codex"), join(appdata, "npm", "codex.cmd")]
      : [];
  if (agent === "codex" && process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"] ?? "";
    const codexBin = join(local, "OpenAI", "Codex", "bin");
    try {
      for (const entry of readdirSync(codexBin)) direct.push(join(codexBin, entry, "codex.exe"));
    } catch { /* desktop Codex is not installed */ }
  }
  if (agent === "pi") {
    direct.push(
      which("pi"),
      join(appdata, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
      join(appdata, "npm", "node_modules", "@mariozechner", "pi-coding-agent", "package.json"),
    );
  }
  return unique(direct.filter((p) => p && existsSync(p)).map((p) => normalizeExternalPath(agent, p!)));
}

function versionFromOutput(text: string): string | null {
  return text.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1] ?? null;
}

async function probeBinary(agent: "claude" | "codex", path: string): Promise<{ version: string | null; diagnostic: string }> {
  const { stdout, stderr } = await execFileAsync(path, ["--version"], {
    timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024,
  });
  const output = `${stdout}\n${stderr}`.trim();
  const identity = agent === "claude" ? /claude/i : /codex/i;
  if (!identity.test(output)) throw new Error(`--version output does not identify ${agent}: ${output.slice(0, 160)}`);
  // A binary that identifies itself but prints no semver returns version
  // null; applyMinVersion then marks it too old (compatibility unprovable).
  const version = versionFromOutput(output);
  return { version, diagnostic: "Executable answered --version; full SDK/protocol compatibility is not asserted." };
}

function piExportEntry(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const map = value as Record<string, unknown>;
  return piExportEntry(map["import"] ?? map["default"] ?? map["node"]);
}

export function probePiPackage(pkgJson: string): { version: string; entry: string; packageDir: string } {
  const data = JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: unknown; version?: unknown; exports?: unknown; main?: unknown };
  if (data.name !== "@earendil-works/pi-coding-agent" && data.name !== "@mariozechner/pi-coding-agent") {
    throw new Error(`Not a supported Pi Coding Agent package: ${String(data.name ?? "unnamed package")}`);
  }
  if (typeof data.version !== "string") throw new Error("Pi package.json has no version");
  const packageDir = dirname(pkgJson);
  const rootExport = data.exports && typeof data.exports === "object" && !Array.isArray(data.exports)
    ? (data.exports as Record<string, unknown>)["."]
    : data.exports;
  const relativeEntry = piExportEntry(rootExport) ?? (typeof data.main === "string" ? data.main : null);
  if (!relativeEntry) throw new Error("Pi package has no import/default export entry");
  const entry = resolve(packageDir, relativeEntry);
  if (!existsSync(entry)) throw new Error(`Pi SDK entry is missing: ${entry}`);
  return { version: data.version, entry, packageDir };
}

/** Numeric major.minor.patch compare; any prerelease/build suffix is
 *  ignored ("2.1.238-beta" == "2.1.238"). Missing / non-numeric segments
 *  count as 0. Returns <0 / 0 / >0 like a comparator. */
export function compareCoreVersions(a: string, b: string): number {
  const parts = (v: string): number[] => {
    const core = v.trim().replace(/^v/, "").split(/[-+]/)[0] ?? "";
    return core.split(".").slice(0, 3).map((s) => {
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
  };
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Apply the RUNTIME_MIN_LOCAL_VERSIONS gate to a successfully probed
 *  candidate. Unknown versions can't prove compatibility → too old. */
function applyMinVersion(agent: RuntimeAgentId, candidate: RuntimeCandidate): RuntimeCandidate {
  if (!candidate.available) return candidate;
  const minVersion = RUNTIME_MIN_LOCAL_VERSIONS[agent];
  if (candidate.version === null) {
    return {
      ...candidate, available: false, compatibility: "incompatible", tooOld: true, minVersion,
      diagnostic: `Could not determine the ${agent} version; MarioCode requires at least ${minVersion} for local runtimes.`,
    };
  }
  if (compareCoreVersions(candidate.version, minVersion) < 0) {
    return {
      ...candidate, available: false, compatibility: "incompatible", tooOld: true, minVersion,
      diagnostic: `Version ${candidate.version} is below the minimum required ${minVersion}. Update the local ${agent} installation.`,
    };
  }
  return candidate;
}

async function probeCandidate(agent: RuntimeAgentId, path: string): Promise<RuntimeCandidate> {
  try {
    if (agent === "pi") {
      const result = probePiPackage(path);
      return applyMinVersion(agent, {
        path, version: result.version, available: true, compatibility: "unknown",
        diagnostic: "Pi package metadata and entry are valid; full provider compatibility is not asserted.",
      });
    }
    const result = await probeBinary(agent, path);
    return applyMinVersion(agent, {
      path, version: result.version, available: true, compatibility: "unknown",
      diagnostic: result.diagnostic,
    });
  } catch (error) {
    return { path, version: null, available: false, compatibility: "incompatible", diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

/** Newest too-old candidate (unknown versions rank last), for the panel's
 *  update reminder. */
export function newestTooOld(candidates: readonly RuntimeCandidate[]): RuntimeLocalTooOld | null {
  let best: RuntimeCandidate | null = null;
  for (const c of candidates) {
    if (!c.tooOld) continue;
    if (!best) { best = c; continue; }
    if (c.version !== null && (best.version === null || compareCoreVersions(c.version, best.version) > 0)) best = c;
  }
  return best ? { path: best.path, version: best.version, minVersion: best.minVersion ?? "" } : null;
}

const probeCache = new Map<RuntimeAgentId, { at: number; values: RuntimeCandidate[] }>();
/** Last discovery result per agent, kept past the TTL so repeated listings
 *  stay cheap. Info-display only since TODO-057 (engines never load from
 *  these). */
export async function discoverExternalRuntimes(agent: RuntimeAgentId): Promise<RuntimeCandidate[]> {
  const cached = probeCache.get(agent);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.values;
  const values = await Promise.all(externalPaths(agent).map((path) => probeCandidate(agent, path)));
  probeCache.set(agent, { at: Date.now(), values });
  return values;
}

/** Fire-and-forget discovery for all agents at startup, so the settings
 *  panel's info block has warm data before the user opens it. */
export function warmRuntimeDiscovery(): void {
  for (const agent of ["claude", "codex", "pi"] as const) {
    discoverExternalRuntimes(agent).catch((error: unknown) => {
      log.warn(`runtime discovery failed (${agent}): ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

const autoPickLogged = new Map<RuntimeAgentId, string>();
/** Log which source AUTO picked — once per agent (again only if it changes). */
export function noteAutoPick(agent: RuntimeAgentId, source: string, path: string | null): void {
  const key = `${source}\u0000${path ?? ""}`;
  if (autoPickLogged.get(agent) === key) return;
  autoPickLogged.set(agent, key);
  log.info(`runtime auto: ${agent} -> ${source} ${path ?? "(sdk self-resolve)"}`);
}

async function validateNode(path: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(path, ["--version"], { timeout: PROBE_TIMEOUT_MS, windowsHide: true });
  const output = `${stdout}${stderr}`.trim();
  const match = output.match(/^v(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`Pi requires a real Node executable; ${path} reported "${output}"`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 22) throw new Error(`Pi requires Node >=22.19; ${path} reported "${output}"`);
  if (major === 22 && minor < 19) throw new Error(`Pi requires Node >=22.19; found ${output}`);
  return output.replace(/^v/, "");
}

export async function validateNodeExecutable(path: string): Promise<string> {
  if (!existsSync(path)) throw new Error(`Configured Node executable is unavailable: ${path}`);
  return await validateNode(canonical(path));
}

function managedNodeCandidates(): string[] {
  const root = getManagedRuntimeRoot();
  if (!root) return [];
  const names = process.platform === "win32" ? ["node.exe"] : [join("bin", "node"), "node"];
  let versions: string[] = [];
  try { versions = readdirSync(join(root, "node")).sort((a, b) => compareVersions(b, a)); } catch { /* not installed */ }
  return versions.flatMap((version) => names.map((name) => join(root, "node", version, name)));
}

/** Pure main-process launch contract consumed by the Pi worker host.
 *  TODO-057: managed copy → dev node_modules fallback only. */
export async function resolvePiRuntimeLaunch(): Promise<{ nodePath: string; sdkEntry: string; sdkPackageDir: string; version: string }> {
  let pkgJson: string | null = null;
  let source = "managed";
  const root = getManagedRuntimeRoot();
  if (root) {
    for (const version of listManagedVersions("pi")) {
      const candidate = join(root, "pi", version, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
      if (existsSync(candidate)) { pkgJson = candidate; break; }
    }
  }
  if (!pkgJson) {
    try {
      const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
      pkgJson = join(dirname(dirname(entry)), "package.json");
      source = "dev";
    } catch { /* no fallback */ }
  }
  if (!pkgJson) throw new Error("Pi SDK is not installed (no managed copy or project fallback). Install it in Settings → Agent.");
  noteAutoPick("pi", source, pkgJson);
  const sdk = probePiPackage(pkgJson);
  const nodeCandidates = unique([...managedNodeCandidates(), which("node")]);
  const failures: string[] = [];
  for (const nodePath of nodeCandidates) {
    if (!existsSync(nodePath)) continue;
    try {
      await validateNode(nodePath);
      return { nodePath, sdkEntry: sdk.entry, sdkPackageDir: sdk.packageDir, version: sdk.version };
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new Error(`No compatible Node runtime for Pi (requires >=22.19).${failures.length ? ` ${failures.join("; ")}` : " Install managed Node."}`);
}

/** Import the selected Pi SDK in the chosen Node process without creating a
 * session or invoking a model. This catches module/engine/API incompatibility. */
export async function validatePiSdkWithNode(pkgJson: string, nodePath: string): Promise<void> {
  const sdk = probePiPackage(pkgJson);
  await validateNodeExecutable(nodePath);
  const script = [
    "import { pathToFileURL } from 'node:url';",
    `const sdk = await import(pathToFileURL(${JSON.stringify(sdk.entry)}).href);`,
    "if (typeof sdk.createAgentSession !== 'function') throw new Error('Pi SDK has no createAgentSession export');",
  ].join("\n");
  await execFileAsync(canonical(nodePath), ["--input-type=module", "--eval", script], {
    timeout: 8_000, windowsHide: true, maxBuffer: 64 * 1024,
  });
}

export async function validateExternalSelection(agent: RuntimeAgentId, path: string): Promise<RuntimeCandidate> {
  const normalized = normalizeExternalPath(agent, path);
  if (!normalized || !existsSync(normalized)) return { path, version: null, available: false, compatibility: "incompatible", diagnostic: `Path does not contain a usable ${agent} runtime.` };
  return await probeCandidate(agent, normalized);
}

/** Persist the execution policy. Both modes are stored as an empty selection
 *  (no path binding — there is nothing external to bind since TODO-057). */
export async function selectRuntime(
  agent: RuntimeAgentId,
  mode: RuntimeMode,
): Promise<{ ok: boolean; error?: string }> {
  saveRuntimeSelection(agent, emptySelection(mode));
  return { ok: true };
}
