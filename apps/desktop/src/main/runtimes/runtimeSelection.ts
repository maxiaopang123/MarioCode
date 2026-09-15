/** Product-level runtime source selection shared by status UI and providers. */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type {
  RuntimeAgentId,
  RuntimeCandidate,
  RuntimeMode,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { which } from "@main/lib/binaryResolve.js";
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
  source: "managed" | "dev" | "bundled" | "external";
  path: string;
  version: string | null;
}

function readSelection(agent: RuntimeAgentId): RuntimeSelection {
  try {
    const raw = SettingRepo.get(selectionKey(agent));
    if (!raw) return emptyManagedSelection();
    const value = JSON.parse(raw) as Partial<RuntimeSelection>;
    return {
      mode: value.mode === "external" ? "external" : "managed",
      path: typeof value.path === "string" && value.path.trim() ? value.path : null,
      nodePath: typeof value.nodePath === "string" && value.nodePath.trim() ? value.nodePath : null,
      verifiedVersion: typeof value.verifiedVersion === "string" ? value.verifiedVersion : null,
      payloadFingerprint: typeof value.payloadFingerprint === "string" ? value.payloadFingerprint : null,
      nodeFingerprint: typeof value.nodeFingerprint === "string" ? value.nodeFingerprint : null,
    };
  } catch {
    return emptyManagedSelection();
  }
}

function emptyManagedSelection(): RuntimeSelection {
  return { mode: "managed", path: null, nodePath: null, verifiedVersion: null, payloadFingerprint: null, nodeFingerprint: null };
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
  const version = versionFromOutput(output);
  if (!version) throw new Error(`--version succeeded but returned no semantic version: ${output.slice(0, 160)}`);
  return { version, diagnostic: "Executable answered --version; full SDK/protocol compatibility is not asserted." };
}

function piExportEntry(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const map = value as Record<string, unknown>;
  return piExportEntry(map["import"] ?? map["default"] ?? map["node"]);
}

function probePiPackage(pkgJson: string): { version: string; entry: string; packageDir: string } {
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

async function probeCandidate(agent: RuntimeAgentId, path: string): Promise<RuntimeCandidate> {
  try {
    if (agent === "pi") {
      const result = probePiPackage(path);
      return {
        path, version: result.version, available: true, compatibility: "unknown",
        diagnostic: "Pi package metadata and entry are valid; full provider compatibility is not asserted.",
      };
    }
    const result = await probeBinary(agent, path);
    return {
      path, version: result.version, available: true, compatibility: "unknown",
      diagnostic: result.diagnostic,
    };
  } catch (error) {
    return { path, version: null, available: false, compatibility: "incompatible", diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

const probeCache = new Map<RuntimeAgentId, { at: number; values: RuntimeCandidate[] }>();
export async function discoverExternalRuntimes(agent: RuntimeAgentId): Promise<RuntimeCandidate[]> {
  const cached = probeCache.get(agent);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.values;
  const values = await Promise.all(externalPaths(agent).map((path) => probeCandidate(agent, path)));
  probeCache.set(agent, { at: Date.now(), values });
  return values;
}

/** Resolve only an explicitly selected external runtime. */
export function resolveExternalRuntimeSync(agent: Exclude<RuntimeAgentId, "pi">): ResolvedRuntime | null {
  const selection = readSelection(agent);
  if (selection.mode !== "external" || !selection.path) return null;
  const path = normalizeExternalPath(agent, selection.path);
  if (!path || !existsSync(path) || !selection.payloadFingerprint || fileFingerprint(path) !== selection.payloadFingerprint) return null;
  return { source: "external", path, version: selection.verifiedVersion };
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

/** Pure main-process launch contract consumed by the Pi worker host. */
export async function resolvePiRuntimeLaunch(): Promise<{ nodePath: string; sdkEntry: string; sdkPackageDir: string; version: string }> {
  const selection = readSelection("pi");
  let pkgJson: string | null = null;
  if (selection.mode === "external") {
    if (!selection.path) throw new Error("Pi external runtime is selected but no package path is configured. Choose a detected Pi installation in Settings.");
    pkgJson = normalizeExternalPath("pi", selection.path);
    if (!pkgJson || !existsSync(pkgJson)) throw new Error(`Configured external Pi package is unavailable: ${selection.path}`);
    const sdkForFingerprint = probePiPackage(pkgJson);
    if (!selection.payloadFingerprint || fileFingerprint(sdkForFingerprint.entry) !== selection.payloadFingerprint) {
      throw new Error("Configured external Pi SDK changed since it was verified. Validate and select it again in Settings.");
    }
    if (!selection.nodePath || !selection.nodeFingerprint || fileFingerprint(selection.nodePath) !== selection.nodeFingerprint) {
      throw new Error("Configured external Pi Node changed or disappeared since it was verified. Validate and select it again in Settings.");
    }
  } else {
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
      } catch { /* no fallback */ }
    }
    if (!pkgJson) throw new Error("Managed Pi SDK is not installed and no project/bundled fallback is available.");
  }
  const sdk = probePiPackage(pkgJson);
  const nodeCandidates = selection.mode === "external"
    ? selection.nodePath ? unique([selection.nodePath]) : unique([which("node")])
    : unique([...managedNodeCandidates(), which("node")]);
  const failures: string[] = [];
  for (const nodePath of nodeCandidates) {
    if (!existsSync(nodePath)) continue;
    try {
      await validateNode(nodePath);
      return { nodePath, sdkEntry: sdk.entry, sdkPackageDir: sdk.packageDir, version: sdk.version };
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new Error(`No compatible Node runtime for Pi (requires >=22.19).${failures.length ? ` ${failures.join("; ")}` : " Install managed Node or configure a system Node executable."}`);
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

export async function validatePiExternalRuntime(pkgJson: string, explicitNodePath?: string): Promise<{ path: string; fingerprint: string }> {
  const nodePath = explicitNodePath?.trim() || which("node");
  if (!nodePath) throw new Error("No system Node executable was found for the external Pi runtime (requires >=22.19).");
  const resolvedNode = canonical(nodePath);
  const before = fileFingerprint(resolvedNode);
  if (!before) throw new Error(`Configured Node executable is unavailable: ${resolvedNode}`);
  await validatePiSdkWithNode(pkgJson, resolvedNode);
  const after = fileFingerprint(resolvedNode);
  if (after !== before) throw new Error("Configured Node executable changed while it was being verified. Try again.");
  return { path: resolvedNode, fingerprint: after! };
}

export async function validateExternalSelection(agent: RuntimeAgentId, path: string): Promise<RuntimeCandidate> {
  const normalized = normalizeExternalPath(agent, path);
  if (!normalized || !existsSync(normalized)) return { path, version: null, available: false, compatibility: "incompatible", diagnostic: `Path does not contain a usable ${agent} runtime.` };
  return await probeCandidate(agent, normalized);
}

export async function validateStoredExternalSelection(agent: RuntimeAgentId): Promise<RuntimeCandidate | null> {
  const selection = readSelection(agent);
  if (selection.mode !== "external" || !selection.path) return null;
  const candidate = await validateExternalSelection(agent, selection.path);
  if (!candidate.available) return candidate;
  const payloadPath = agent === "pi" ? probePiPackage(candidate.path).entry : candidate.path;
  if (!selection.payloadFingerprint || fileFingerprint(payloadPath) !== selection.payloadFingerprint) {
    return { ...candidate, available: false, compatibility: "incompatible", diagnostic: "External runtime payload changed since verification. Validate and select it again." };
  }
  if (!selection.verifiedVersion || candidate.version !== selection.verifiedVersion) {
    return { ...candidate, available: false, compatibility: "incompatible", diagnostic: `External runtime version changed since verification (${selection.verifiedVersion ?? "unknown"} -> ${candidate.version ?? "unknown"}). Validate and select it again.` };
  }
  return candidate;
}

/** Validate completely before persisting, so a failed selection never
 * replaces the last working policy. Caller owns the running-turn guard. */
export async function selectRuntime(
  agent: RuntimeAgentId,
  mode: RuntimeMode,
  path?: string,
  nodePath?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (mode === "managed") {
    saveRuntimeSelection(agent, emptyManagedSelection());
    return { ok: true };
  }
  if (!path?.trim()) return { ok: false, error: "Choose an external runtime path before enabling external mode." };
  const normalized = normalizeExternalPath(agent, path);
  if (!normalized || !existsSync(normalized)) return { ok: false, error: `Path does not contain a usable ${agent} runtime.` };
  const payloadPath = agent === "pi" ? probePiPackage(normalized).entry : normalized;
  const before = fileFingerprint(payloadPath);
  const candidate = await probeCandidate(agent, normalized);
  if (!candidate.available) return { ok: false, error: candidate.diagnostic };
  const after = fileFingerprint(payloadPath);
  if (!before || after !== before) return { ok: false, error: "Runtime payload changed while it was being verified. Try again." };
  let selectedNodePath = nodePath?.trim() || null;
  let selectedNodeFingerprint: string | null = null;
  if (agent === "pi") {
    try {
      const node = await validatePiExternalRuntime(candidate.path, nodePath);
      selectedNodePath = node.path;
      selectedNodeFingerprint = node.fingerprint;
    }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  saveRuntimeSelection(agent, {
    mode, path: candidate.path, nodePath: selectedNodePath,
    verifiedVersion: candidate.version,
    payloadFingerprint: after,
    nodeFingerprint: selectedNodeFingerprint,
  });
  return { ok: true };
}
