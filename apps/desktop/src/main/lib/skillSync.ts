/**
 * External skill sync engine (TODO-004).
 *
 * The user attaches external skill directories (Claude Code ~/.claude/skills,
 * Codex ~/.codex/skills, Zcode ~/.agents/skills, or any picked folder) as
 * sync sources in the settings panel. Each ENABLED source is mirrored by
 * copy into `~/.mariocode/skills-sync/<sourceId>/` and followed in real time
 * with fs.watch; the composer `/` menu scans the mirror root as an extra
 * skills root alongside the global (~/.mariocode/skills) and project roots.
 *
 * Design decisions (from the TODO-004 sign-off):
 *  - Separate mirror directory per source, plain COPY sync (no junctions /
 *    symlinks — Windows needs no privilege for copies).
 *  - One-way only (source → mirror); the mirror is app-managed and must not
 *    be hand-edited (the panel does not expose an editor for it).
 *  - Real-time follow: recursive fs.watch with a debounce; a structural
 *    rescan replaces the mirror wholesale (simple + always converges).
 *
 * Electron-free by design: this module is also bundled into the Pi host
 * (build/build-pi-host.mjs rejects any electron dependency), so renderer
 * notifications go through an injectable listener — the Electron entry
 * (main/index.ts) wires `sendToRenderer`; the Pi host leaves it unwired.
 */
import { watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { MARIOCODE_HOME } from "@main/lib/appHome.js";
import { createHash } from "node:crypto";
import {
  SKILL_SYNC_SOURCES_SETTING_KEY,
  type SkillSyncSource,
  type SkillSyncStatus,
} from "@contracts/ipc";
import { awaitDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

/** Renderer-notification hook. Wired by the Electron entry only — the Pi
 *  host bundles this module without Electron, so pushing stays a no-op
 *  there. */
let changeListener: (() => void) | null = null;
export function setSkillSyncChangeListener(listener: () => void): void {
  changeListener = listener;
}

/** Root of all per-source mirror directories. */
export const SKILL_SYNC_ROOT = path.join(MARIOCODE_HOME, "skills-sync");

/** Synthesized plugin dirs (Claude-side skill visibility): one per source,
 *  holding a minimal `.claude-plugin/plugin.json` + a `skills/` directory
 *  whose children are copies of the mirror's skill folders. */
export const SKILL_SYNC_PLUGINS_ROOT = path.join(MARIOCODE_HOME, "skills-sync-plugins");

/** Debounce window for fs.watch bursts (editors save via rename storms). */
const WATCH_DEBOUNCE_MS = 400;

interface RuntimeState {
  watcher: FSWatcher | null;
  debounce: NodeJS.Timeout | null;
  syncing: boolean;
  pendingResync: boolean;
  status: SkillSyncStatus;
}

const runtime = new Map<string, RuntimeState>();

function emptyStatus(): SkillSyncStatus {
  return { skillCount: 0, lastSyncAt: null, lastError: null };
}

function stateFor(id: string): RuntimeState {
  let st = runtime.get(id);
  if (!st) {
    st = { watcher: null, debounce: null, syncing: false, pendingResync: false, status: emptyStatus() };
    runtime.set(id, st);
  }
  return st;
}

/** Derive a stable source id from its directory path (short hash, readable
 *  prefix from the directory basename). */
export function sourceIdFor(sourceDir: string): string {
  const hash = createHash("sha1").update(path.resolve(sourceDir).toLowerCase()).digest("hex").slice(0, 10);
  const base = path.basename(path.resolve(sourceDir)).replace(/[^\w.-]/g, "_").slice(0, 24) || "skills";
  return `${base}-${hash}`;
}

/** Read the persisted source list. AwaitDb-guarded in the Electron path
 *  because startup calls this before the first IPC arrives; the Pi host's
 *  JSON-file override skips the await. */
export async function getSkillSyncSources(): Promise<SkillSyncSource[]> {
  await awaitDb();
  const raw = SettingRepo.get(SKILL_SYNC_SOURCES_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is SkillSyncSource =>
        typeof s === "object" && s !== null &&
        typeof (s as SkillSyncSource).id === "string" &&
        typeof (s as SkillSyncSource).sourceDir === "string" &&
        typeof (s as SkillSyncSource).label === "string" &&
        typeof (s as SkillSyncSource).enabled === "boolean",
    );
  } catch {
    return [];
  }
}

function saveSkillSyncSources(sources: SkillSyncSource[]): void {
  SettingRepo.set(SKILL_SYNC_SOURCES_SETTING_KEY, JSON.stringify(sources));
}

/** Mirror directory for one source. */
export function mirrorDirFor(id: string): string {
  return path.join(SKILL_SYNC_ROOT, id);
}

/** True when `name` is a plausible skill directory (has SKILL.md). */
async function isSkillDir(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(dir, "SKILL.md"));
    return st.isFile();
  } catch {
    return false;
  }
}

/** Full mirror rebuild: enumerate skill dirs under the source root, copy each
 *  into `<mirror>/<skillName>/`, drop mirror entries whose source vanished.
 *  Never throws — errors surface in the source's status. */
async function runSync(source: SkillSyncSource): Promise<void> {
  const st = stateFor(source.id);
  if (st.syncing) {
    st.pendingResync = true;
    return;
  }
  st.syncing = true;
  try {
    const mirror = mirrorDirFor(source.id);
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(source.sourceDir, { withFileTypes: true });
    } catch (err) {
      st.status.lastError = `源目录不可读: ${(err as Error).message}`;
      st.status.lastSyncAt = new Date().toISOString();
      notifyChanged();
      return;
    }
    const names = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === ".system") continue; // Codex built-ins
      const srcSkill = path.join(source.sourceDir, entry.name);
      if (!(await isSkillDir(srcSkill))) continue;
      names.add(entry.name);
      const dest = path.join(mirror, entry.name);
      try {
        await fs.rm(dest, { recursive: true, force: true });
        await fs.cp(srcSkill, dest, { recursive: true });
      } catch (err) {
        st.status.lastError = `复制 ${entry.name} 失败: ${(err as Error).message}`;
        notifyChanged();
        return;
      }
    }
    // Prune mirror entries whose source vanished.
    try {
      const existing = await fs.readdir(mirror, { withFileTypes: true });
      for (const e of existing) {
        if (!names.has(e.name)) {
          await fs.rm(path.join(mirror, e.name), { recursive: true, force: true });
        }
      }
    } catch {
      // mirror dir absent on first sync — fine
    }
    st.status = { skillCount: names.size, lastSyncAt: new Date().toISOString(), lastError: null };
    log.info(`skillSync: ${source.label} → ${names.size} skills mirrored`);
    notifyChanged();
    await materializeSyncPlugin(source);
  } finally {
    st.syncing = false;
    if (st.pendingResync) {
      st.pendingResync = false;
      void runSync(source);
    }
  }
}

/** Rebuild the synthesized Claude-plugin directory for one source, so the
 *  Claude provider can expose the synced skills through `options.plugins`.
 *  Layout: `<root>/<pluginName>/.claude-plugin/plugin.json` + `skills/<name>/…`
 *  (copied). Failures only degrade Claude-side visibility, never the mirror. */
async function materializeSyncPlugin(source: SkillSyncSource): Promise<void> {
  const pluginName = `mariocode-sync-${source.id.replace(/[^\w.-]/g, "-").toLowerCase()}`;
  const pluginDir = path.join(SKILL_SYNC_PLUGINS_ROOT, pluginName);
  const mirror = mirrorDirFor(source.id);
  try {
    await fs.rm(pluginDir, { recursive: true, force: true });
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(mirror, { withFileTypes: true });
    } catch {
      return; // no mirror → no plugin dir either
    }
    const skillsDst = path.join(pluginDir, "skills");
    let count = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      await fs.cp(path.join(mirror, e.name), path.join(skillsDst, e.name), { recursive: true });
      count++;
    }
    await fs.mkdir(path.join(pluginDir, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: pluginName,
        version: "0.0.0",
        description: `Synced skills from ${source.label} (auto-generated by MarioCode skill sync)`,
      }),
      "utf-8",
    );
    log.info(`skillSync: claude plugin materialized (${pluginName}, ${count} skills)`);
  } catch (err) {
    log.warn(`skillSync: claude plugin materialize failed: ${(err as Error).message}`);
  }
}

/** Remove the synthesized plugin dir for one source (mirror removal calls
 *  this alongside deleting the mirror). */
export async function removeSyncPluginDir(id: string): Promise<void> {
  const pluginName = `mariocode-sync-${id.replace(/[^\w.-]/g, "-").toLowerCase()}`;
  await fs.rm(path.join(SKILL_SYNC_PLUGINS_ROOT, pluginName), { recursive: true, force: true }).catch(() => {});
}

/** Plugin dirs the Claude provider should add to `options.plugins` (one per
 *  enabled sync source whose synthesized dir exists). */
export function skillSyncPluginRootsSync(): string[] {
  let sources: SkillSyncSource[] = [];
  try {
    const raw = SettingRepo.get(SKILL_SYNC_SOURCES_SETTING_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) sources = parsed as SkillSyncSource[];
    }
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const s of sources) {
    if (!s.enabled) continue;
    const pluginName = `mariocode-sync-${s.id.replace(/[^\w.-]/g, "-").toLowerCase()}`;
    const dir = path.join(SKILL_SYNC_PLUGINS_ROOT, pluginName);
    try {
      if (existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) roots.push(dir);
    } catch {
      // not materialized yet
    }
  }
  return roots;
}

/** Attach a recursive watcher to the source dir. When the source disappears
 *  entirely, the mirror is emptied and watching stops (status shows the error). */
async function startWatching(source: SkillSyncSource): Promise<void> {
  const st = stateFor(source.id);
  stopWatching(source.id);
  await runSync(source);
  try {
    st.watcher = watch(source.sourceDir, { recursive: true }, () => {
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
    st.status.lastError = `无法监听源目录: ${(err as Error).message}`;
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

function notifyChanged(): void {
  try {
    changeListener?.();
  } catch (err) {
    log.warn(`skill sync change listener failed: ${(err as Error).message}`);
  }
}

/** Public: list sources with live status. */
export async function listSkillSync(): Promise<Array<SkillSyncSource & { status: SkillSyncStatus }>> {
  const sources = await getSkillSyncSources();
  return sources.map((s) => ({ ...s, status: { ...stateFor(s.id).status } }));
}

/** Public: add a source (idempotent per sourceDir), start sync if enabled. */
export async function addSkillSyncSource(sourceDir: string, label?: string): Promise<{ ok: boolean; error?: string; id?: string }> {
  const resolved = path.resolve(sourceDir);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) return { ok: false, error: "目录不存在" };
  const sources = await getSkillSyncSources();
  const id = sourceIdFor(resolved);
  const existing = sources.find((s) => s.id === id);
  if (existing) return { ok: false, error: "该目录已在同步列表中", id };
  const next: SkillSyncSource = {
    id,
    label: label?.trim() || path.basename(resolved) || id,
    sourceDir: resolved,
    enabled: true,
  };
  saveSkillSyncSources([...sources, next]);
  void startWatching(next);
  return { ok: true, id };
}

/** Public: toggle enabled; disabling stops the watcher but KEEPS the mirror
 *  (the skills remain listed — that's the documented semantic of a disabled
 *  source: frozen snapshot, no longer following the origin). */
export async function setSkillSyncEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const sources = await getSkillSyncSources();
  const idx = sources.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: false, error: "来源不存在" };
  const next = sources.slice();
  next[idx] = { ...next[idx], enabled };
  saveSkillSyncSources(next);
  if (enabled) {
    void startWatching(next[idx]);
  } else {
    stopWatching(id);
  }
  notifyChanged();
  return { ok: true };
}

/** Public: remove a source and delete its mirror directory. */
export async function removeSkillSyncSource(id: string): Promise<{ ok: boolean; error?: string }> {
  const sources = await getSkillSyncSources();
  const next = sources.filter((s) => s.id !== id);
  if (next.length === sources.length) return { ok: false, error: "来源不存在" };
  saveSkillSyncSources(next);
  stopWatching(id);
  runtime.delete(id);
  await fs.rm(mirrorDirFor(id), { recursive: true, force: true }).catch(() => {});
  await removeSyncPluginDir(id);
  notifyChanged();
  return { ok: true };
}

/** Public: force rescan of one or all sources. */
export async function rescanSkillSync(id?: string): Promise<{ ok: boolean; error?: string }> {
  const sources = await getSkillSyncSources();
  const targets = id ? sources.filter((s) => s.id === id) : sources.filter((s) => s.enabled);
  if (id && targets.length === 0) return { ok: false, error: "来源不存在" };
  await Promise.all(targets.map((s) => runSync(s)));
  return { ok: true };
}

/** Startup hook: begin watching every enabled source. Called once from the
 *  main entry after the DB is ready. */
export async function startSkillSyncEngine(): Promise<void> {
  try {
    await fs.mkdir(SKILL_SYNC_ROOT, { recursive: true });
    const sources = await getSkillSyncSources();
    for (const s of sources) {
      if (s.enabled) void startWatching(s);
    }
    if (sources.length > 0) {
      log.info(`skillSync: engine started with ${sources.filter((s) => s.enabled).length}/${sources.length} enabled sources`);
    }
  } catch (err) {
    log.warn(`skillSync: engine start failed: ${(err as Error).message}`);
  }
}

/** Roots to scan for synced skills: one mirror dir per ENABLED source that
 *  currently exists on disk. */
export async function skillSyncMirrorRoots(): Promise<string[]> {
  const sources = await getSkillSyncSources();
  const roots: string[] = [];
  for (const s of sources) {
    if (!s.enabled) continue;
    const dir = mirrorDirFor(s.id);
    try {
      if ((await fs.stat(dir)).isDirectory()) roots.push(dir);
    } catch {
      // not synced yet
    }
  }
  return roots;
}

/** Synchronous variant of {@link skillSyncMirrorRoots} for provider code
 *  paths that build their skill-root list inside a synchronous function
 *  (Pi's buildPiSkillLoader, Codex's skillRootsFor). SettingRepo reads are
 *  synchronous (better-sqlite3), so only the settings lookup is reused;
 *  callers must have awaited DB readiness upstream (providers do). */
export function skillSyncMirrorRootsSync(): string[] {
  let sources: SkillSyncSource[] = [];
  try {
    const raw = SettingRepo.get(SKILL_SYNC_SOURCES_SETTING_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) sources = parsed as SkillSyncSource[];
    }
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const s of sources) {
    if (!s.enabled) continue;
    const dir = mirrorDirFor(s.id);
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) roots.push(dir);
    } catch {
      // not synced yet
    }
  }
  return roots;
}
