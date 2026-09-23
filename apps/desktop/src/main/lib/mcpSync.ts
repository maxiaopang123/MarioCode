/**
 * External MCP config sync engine (TODO-004, MCP half).
 *
 * The user attaches external tool config files (Claude CLI ~/.claude.json,
 * Codex ~/.codex/config.toml, Cursor ~/.cursor/mcp.json, Zcode
 * ~/.zcode/mcp.json, or any picked file) as sync sources in the settings
 * panel. Each ENABLED source is parsed (read-only — the file is never
 * written), every recognized server is normalized into McpServerConfig and
 * mirrored into ~/.mcode/.claude.json's `mcpServers`. That file is the
 * single point of truth for BOTH Claude (the binary loads it directly) and
 * Codex (config.toml materialization reads it), so one mirror serves every
 * provider.
 *
 * Merge rules (deliberately conservative):
 *  - One-way only (source → mirror). The source file is never modified.
 *  - Ownership tracking: the set of names each source synced in on its last
 *    pass is kept in the settings table. Re-sync replaces only the previous
 *    pass's names; a server the user edited locally since it was synced in
 *    is left alone from then on (local wins).
 *  - A name that already exists in the file and was NOT written by sync
 *    (local manual entry, or the one-shot import) is skipped, not
 *    overwritten — surfaced in the status as a conflict.
 *  - Removing / disabling a source retracts exactly the names it owns.
 *  - Codex stdio TOML supports `env` as an inline table; env VALUES that
 *    reference the user's own env ("${VAR}" / "$VAR" / "%VAR%") are dropped
 *    (Codex resolves them against the app-server process env, where they
 *    don't exist) — the server still syncs, just without those values.
 *
 * Electron-free by design: this module is also bundled into the Pi host
 * (build/build-pi-host.mjs rejects any electron dependency), so renderer
 * notifications go through an injectable listener — the Electron entry
 * (main/index.ts) wires `sendToRenderer`; the Pi host leaves it unwired.
 */
import { watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import {
  MCP_SYNC_SOURCES_SETTING_KEY,
  type McpSyncCandidate,
  type McpSyncKind,
  type McpSyncSource,
  type McpSyncStatus,
} from "@contracts/ipc";
import { awaitDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import {
  parseMcpConfig,
  readUserClaudeJson,
  writeUserClaudeJson,
  mcpServersOf,
} from "@main/lib/mcpConfig.js";
import type { McpServerConfig } from "@contracts/ipc";

/** Renderer-notification hook. Wired by the Electron entry only. */
let changeListener: (() => void) | null = null;
export function setMcpSyncChangeListener(listener: () => void): void {
  changeListener = listener;
}
function notifyChanged(): void {
  try {
    changeListener?.();
  } catch (err) {
    log.warn(`mcp sync change listener failed: ${(err as Error).message}`);
  }
}

/** Debounce window for fs.watch bursts (~/.claude.json is rewritten often
 *  by the CLI — scan once the file settles). */
const WATCH_DEBOUNCE_MS = 600;

/** Setting key holding the ownership map: sourceId → server names synced in
 *  by that source's last pass. Enables retraction + local-wins detection. */
const OWNERSHIP_SETTING_KEY = "mcpSync.ownership";

type Ownership = Record<string, string[]>;

interface RuntimeState {
  watcher: FSWatcher | null;
  debounce: NodeJS.Timeout | null;
  syncing: boolean;
  pendingResync: boolean;
  status: McpSyncStatus;
}

const runtime = new Map<string, RuntimeState>();

function emptyStatus(): McpSyncStatus {
  return { serverNames: [], lastSyncAt: null, lastError: null };
}

function stateFor(id: string): RuntimeState {
  let st = runtime.get(id);
  if (!st) {
    st = { watcher: null, debounce: null, syncing: false, pendingResync: false, status: emptyStatus() };
    runtime.set(id, st);
  }
  return st;
}

/* ── Persistence ── */

export async function getMcpSyncSources(): Promise<McpSyncSource[]> {
  await awaitDb();
  const raw = SettingRepo.get(MCP_SYNC_SOURCES_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is McpSyncSource =>
        typeof s === "object" && s !== null &&
        typeof (s as McpSyncSource).id === "string" &&
        typeof (s as McpSyncSource).file === "string" &&
        typeof (s as McpSyncSource).label === "string" &&
        typeof (s as McpSyncSource).enabled === "boolean",
    );
  } catch {
    return [];
  }
}

function saveMcpSyncSources(sources: McpSyncSource[]): void {
  SettingRepo.set(MCP_SYNC_SOURCES_SETTING_KEY, JSON.stringify(sources));
}

function readOwnership(): Ownership {
  const raw = SettingRepo.get(OWNERSHIP_SETTING_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Ownership)
      : {};
  } catch {
    return {};
  }
}

function writeOwnership(map: Ownership): void {
  SettingRepo.set(OWNERSHIP_SETTING_KEY, JSON.stringify(map));
}

/** Derive a stable source id from its file path. */
function sourceIdFor(file: string): string {
  const hash = createHash("sha1").update(path.resolve(file).toLowerCase()).digest("hex").slice(0, 10);
  const base = path.basename(path.dirname(path.resolve(file))).replace(/[^\w.-]/g, "_").slice(0, 24) || "mcp";
  return `${base}-${hash}`;
}

/* ── Source parsing ── */

/** Narrow an unknown JSON value to a plain record, or null. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** True when a string value references the user's own environment
 *  ("${VAR}", "$VAR", "%VAR%") — unresolvable inside Mcode's subprocess. */
const ENV_REF_RE = /\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|%[^%]+%/;

/** Drop env values that reference the user's environment (Codex-style
 *  `${VAR}` indirection); literal values pass through. */
function sanitizeEnv(env: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (ENV_REF_RE.test(v)) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Strip env-reference values from a parsed config (recurses into env only —
 *  headers carry literal tokens, never env refs in practice). */
function sanitizeConfig(cfg: McpServerConfig): McpServerConfig {
  if (cfg.type === "http" || cfg.type === "sse") return cfg;
  const env = sanitizeEnv(cfg.env as Record<string, unknown> | undefined);
  if (!env) {
    const { env: _dropped, ...rest } = cfg;
    return rest as McpServerConfig;
  }
  return { ...cfg, env };
}

/** Parse a Codex TOML `[mcp_servers.<name>]` table into an McpServerConfig
 *  candidate, or null when unrepresentable. */
function codexTomlServer(raw: unknown): McpServerConfig | null {
  const cfg = asRecord(raw);
  if (!cfg) return null;
  if (typeof cfg.url === "string" && cfg.url) {
    const headers = asRecord(cfg.http_headers);
    const config: Record<string, unknown> = { type: "http", url: cfg.url };
    if (headers) {
      const hs: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") hs[k] = v;
      }
      if (Object.keys(hs).length > 0) config.headers = hs;
    }
    return parseMcpConfig(config);
  }
  if (typeof cfg.command === "string" && cfg.command) {
    const config: Record<string, unknown> = { command: cfg.command };
    if (Array.isArray(cfg.args)) {
      const args = cfg.args.filter((a): a is string => typeof a === "string");
      if (args.length > 0) config.args = args;
    }
    const env = sanitizeEnv(asRecord(cfg.env) ?? undefined);
    if (env) config.env = env;
    return parseMcpConfig(config);
  }
  return null;
}

/** Parse one source file into { name → normalized config }. Kind-aware:
 *  - claude / cursor / zcode / other: JSON, top-level `mcpServers` record
 *    (claude additionally scans `projects[*].mcpServers`, dedup by name with
 *    the global scope winning).
 *  - codex: TOML, `[mcp_servers]` tables (smol-toml).
 *  Never throws — returns null on any failure (caller surfaces the error). */
export async function parseSourceFile(
  file: string,
  kind: McpSyncKind,
): Promise<Record<string, McpServerConfig> | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
  if (kind === "codex") {
    return parseCodexToml(text);
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  const rec = asRecord(root);
  if (!rec) return null;
  const out: Record<string, McpServerConfig> = {};
  const merge = (servers: Record<string, unknown>) => {
    for (const [name, raw] of Object.entries(servers)) {
      if (name in out) continue;
      const cfg = parseMcpConfig(raw);
      if (cfg) out[name] = sanitizeConfig(cfg);
    }
  };
  merge(asRecord(rec.mcpServers) ?? {});
  if (kind === "claude") {
    const projects = asRecord(rec.projects);
    if (projects) {
      for (const proj of Object.values(projects)) {
        const pr = asRecord(proj);
        if (pr) merge(asRecord(pr.mcpServers) ?? {});
      }
    }
  }
  return out;
}

/** Parse a Codex config.toml's `[mcp_servers]` section (smol-toml). */
function parseCodexToml(text: string): Record<string, McpServerConfig> | null {
  try {
    const root = asRecord(parseToml(text));
    const servers = root ? asRecord(root.mcp_servers) : null;
    if (!servers) return {};
    const out: Record<string, McpServerConfig> = {};
    for (const [name, raw] of Object.entries(servers)) {
      const cfg = codexTomlServer(raw);
      if (cfg) out[name] = cfg;
    }
    return out;
  } catch {
    return null;
  }
}

/* ── Well-known source detection ── */

interface PresetSpec {
  kind: McpSyncKind;
  label: string;
  file: string;
}

function presetSpecs(): PresetSpec[] {
  const home = homedir();
  return [
    { kind: "claude", label: "Claude Code", file: path.join(home, ".claude.json") },
    { kind: "codex", label: "Codex", file: path.join(home, ".codex", "config.toml") },
    { kind: "cursor", label: "Cursor", file: path.join(home, ".cursor", "mcp.json") },
    { kind: "zcode", label: "Zcode", file: path.join(home, ".zcode", "mcp.json") },
  ];
}

/** Detect kind from a picked file path (basename heuristics). */
function detectKind(file: string): McpSyncKind {
  const base = path.basename(file).toLowerCase();
  if (base === "config.toml") return "codex";
  if (base === ".claude.json") return "claude";
  if (base === "mcp.json") {
    const dir = path.basename(path.dirname(file)).toLowerCase();
    if (dir === ".cursor") return "cursor";
    if (dir === ".zcode" || dir === ".agents") return "zcode";
  }
  return "other";
}

/** Scan the well-known locations; returns candidates (with server counts). */
export async function scanMcpSyncCandidates(): Promise<McpSyncCandidate[]> {
  const sources = await getMcpSyncSources();
  const added = new Set(sources.map((s) => path.resolve(s.file).toLowerCase()));
  const out: McpSyncCandidate[] = [];
  for (const spec of presetSpecs()) {
    if (!existsSync(spec.file)) continue;
    const servers = await parseSourceFile(spec.file, spec.kind);
    out.push({
      kind: spec.kind,
      label: spec.label,
      file: spec.file,
      serverCount: servers ? Object.keys(servers).length : 0,
      added: added.has(path.resolve(spec.file).toLowerCase()),
    });
  }
  return out;
}

/* ── Merge engine ── */

/** Sync one source into ~/.mcode/.claude.json: read the source, upsert the
 *  servers it provides, retract names it no longer provides (only ones it
 *  still owns and that match the config it wrote). Never throws — errors
 *  land in the source status. */
async function runSync(source: McpSyncSource): Promise<void> {
  const st = stateFor(source.id);
  if (st.syncing) {
    st.pendingResync = true;
    return;
  }
  st.syncing = true;
  try {
    const servers = await parseSourceFile(source.file, source.kind);
    if (!servers) {
      st.status.lastError = "源文件不可读或解析失败";
      st.status.lastSyncAt = new Date().toISOString();
      notifyChanged();
      return;
    }
    const cfg = await readUserClaudeJson();
    const fileServers = mcpServersOf(cfg);
    const ownership = readOwnership();
    const prevOwned = new Set(ownership[source.id] ?? []);
    const nextOwned: string[] = [];
    const conflicts: string[] = [];

    // Retract names the source no longer provides. We only retract entries
    // this source still OWNS (present in the previous pass's ownership list);
    // a name the user re-added via the panel loses its ownership (see
    // clearOwnershipFor) and is therefore left alone.
    for (const name of prevOwned) {
      if (name in servers) continue;
      if (name in fileServers) delete fileServers[name];
    }

    for (const [name, config] of Object.entries(servers)) {
      if (name in fileServers && !prevOwned.has(name)) {
        // Pre-existing local entry we don't own — never overwrite.
        conflicts.push(name);
        continue;
      }
      fileServers[name] = config;
      nextOwned.push(name);
    }

    cfg.mcpServers = fileServers;
    await writeUserClaudeJson(cfg);
    ownership[source.id] = nextOwned;
    writeOwnership(ownership);

    st.status = {
      serverNames: nextOwned,
      lastSyncAt: new Date().toISOString(),
      lastError: conflicts.length > 0 ? `同名本地配置保留:${conflicts.join(", ")}` : null,
    };
    log.info(`mcpSync: ${source.label} → ${nextOwned.length} server(s) mirrored${conflicts.length ? `, ${conflicts.length} conflict(s) kept local` : ""}`);
    notifyChanged();
  } catch (err) {
    st.status.lastError = (err as Error).message;
    st.status.lastSyncAt = new Date().toISOString();
    notifyChanged();
  } finally {
    st.syncing = false;
    if (st.pendingResync) {
      st.pendingResync = false;
      void runSync(source);
    }
  }
}

/** Retract every server `id` owns from the mirror file. */
async function retractSource(id: string): Promise<void> {
  const ownership = readOwnership();
  const owned = ownership[id] ?? [];
  if (owned.length > 0) {
    try {
      const cfg = await readUserClaudeJson();
      const fileServers = mcpServersOf(cfg);
      for (const name of owned) delete fileServers[name];
      cfg.mcpServers = fileServers;
      await writeUserClaudeJson(cfg);
    } catch (err) {
      log.warn(`mcpSync: retract ${id} failed: ${(err as Error).message}`);
    }
  }
  delete ownership[id];
  writeOwnership(ownership);
}

/** Clear ownership for a name the user re-added locally via the panel, so a
 *  later sync never retracts their hand-written entry. Exported for the MCP
 *  panel's save/import paths. */
export function clearOwnershipFor(name: string): void {
  const ownership = readOwnership();
  let changed = false;
  for (const id of Object.keys(ownership)) {
    if (ownership[id].includes(name)) {
      ownership[id] = ownership[id].filter((n) => n !== name);
      changed = true;
    }
  }
  if (changed) writeOwnership(ownership);
}

/* ── Watching ── */

async function startWatching(source: McpSyncSource): Promise<void> {
  const st = stateFor(source.id);
  stopWatching(source.id);
  await runSync(source);
  // Watch the parent DIRECTORY, not the file: editors (and the Claude CLI)
  // rewrite config files via replace, which breaks file-level watchers.
  try {
    const dir = path.dirname(source.file);
    const base = path.basename(source.file);
    st.watcher = watch(dir, (_event, filename) => {
      if (filename && filename.toString() !== base) return;
      if (st.debounce) clearTimeout(st.debounce);
      st.debounce = setTimeout(() => {
        st.debounce = null;
        void runSync(source);
      }, WATCH_DEBOUNCE_MS);
    });
    st.watcher.on("error", (err) => {
      st.status.lastError = `监听失败: ${err.message}`;
      notifyChanged();
    });
  } catch (err) {
    st.status.lastError = `无法监听源文件: ${(err as Error).message}`;
    notifyChanged();
  }
}

function stopWatching(id: string): void {
  const st = runtime.get(id);
  if (!st) return;
  if (st.debounce) clearTimeout(st.debounce);
  st.debounce = null;
  st.watcher?.close();
  st.watcher = null;
}

/* ── Public API (IPC layer) ── */

export async function listMcpSync(): Promise<Array<McpSyncSource & { status: McpSyncStatus }>> {
  const sources = await getMcpSyncSources();
  return sources.map((s) => ({ ...s, status: { ...stateFor(s.id).status } }));
}

export async function addMcpSyncSource(
  file: string,
  kind?: McpSyncKind,
  label?: string,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const resolved = path.resolve(file);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) return { ok: false, error: "文件不存在" };
  const sources = await getMcpSyncSources();
  const id = sourceIdFor(resolved);
  if (sources.some((s) => s.id === id)) return { ok: false, error: "该文件已在同步列表中", id };
  const detected = kind ?? detectKind(resolved);
  const next: McpSyncSource = {
    id,
    label: label?.trim() || presetSpecs().find((p) => p.kind === detected)?.label || path.basename(resolved),
    kind: detected,
    file: resolved,
    enabled: true,
  };
  saveMcpSyncSources([...sources, next]);
  void startWatching(next);
  return { ok: true, id };
}

export async function setMcpSyncEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const sources = await getMcpSyncSources();
  const idx = sources.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: false, error: "来源不存在" };
  const next = sources.slice();
  next[idx] = { ...next[idx], enabled };
  saveMcpSyncSources(next);
  if (enabled) {
    void startWatching(next[idx]);
  } else {
    stopWatching(id);
    // Disabling retracts the synced entries (frozen-but-active would
    // silently keep stale servers loading).
    await retractSource(id);
    stateFor(id).status = emptyStatus();
  }
  notifyChanged();
  return { ok: true };
}

export async function removeMcpSyncSource(id: string): Promise<{ ok: boolean; error?: string }> {
  const sources = await getMcpSyncSources();
  const next = sources.filter((s) => s.id !== id);
  if (next.length === sources.length) return { ok: false, error: "来源不存在" };
  saveMcpSyncSources(next);
  stopWatching(id);
  await retractSource(id);
  runtime.delete(id);
  notifyChanged();
  return { ok: true };
}

export async function rescanMcpSync(id?: string): Promise<{ ok: boolean; error?: string }> {
  const sources = await getMcpSyncSources();
  const targets = id ? sources.filter((s) => s.id === id) : sources.filter((s) => s.enabled);
  if (id && targets.length === 0) return { ok: false, error: "来源不存在" };
  await Promise.all(targets.map((s) => runSync(s)));
  return { ok: true };
}

/** Startup hook: begin watching every enabled source. */
export async function startMcpSyncEngine(): Promise<void> {
  try {
    const sources = await getMcpSyncSources();
    for (const s of sources) {
      if (s.enabled) void startWatching(s);
    }
    if (sources.length > 0) {
      log.info(`mcpSync: engine started with ${sources.filter((s) => s.enabled).length}/${sources.length} enabled sources`);
    }
  } catch (err) {
    log.warn(`mcpSync: engine start failed: ${(err as Error).message}`);
  }
}
