/**
 * Skill marketplace (TODO-020).
 *
 * A market is a git repo (`https://…`, shallow-cloned) or an absolute local
 * directory (copied) whose tree contains SKILL.md-bearing folders. Trees are
 * materialized under `~/.mcode/skill-market/<id>/` (never edited by the user);
 * installing a skill copies its folder into `~/.mcode/skills/<name>` — the
 * global root all three engines already load — so it's live on the next turn.
 *
 * Persistence: only user-added market records live in the settings table
 * (`skillMarket.sources`); builtin markets are always present. The settings
 * read/write is isolated in `readRecords` / `writeRecords` so the scan/install
 * core (`scanMarketTree`, `installSkillFromTree`, …) is Electron-free and can
 * be bundled by the offline smoke (apps/desktop/scripts/skill-market-smoke).
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  BUILTIN_SKILL_MARKETS,
  SKILL_MARKET_SOURCES_SETTING_KEY,
  SKILL_NAME_RE,
} from "@contracts/ipc";
import type { SkillMarketEntry, SkillMarketState } from "@contracts/ipc";
import { awaitDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { gitClone } from "@main/lib/fetchTools.js";
import { parseSkillFrontmatter, readTextHead } from "@main/lib/skillFrontmatter.js";

/** Max directory depth (below the tree root) searched for SKILL.md. */
const SCAN_MAX_DEPTH = 4;
const DESCRIPTION_MAX = 300;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const MARKET_ID_RE = /^[a-z0-9-]+$/;

/** One user-added market, as persisted in the settings table. */
export interface SkillMarketRecord {
  id: string;
  name: string;
  url: string;
  addedAt: string;
}

/* ── Paths ── */

export function marketRoot(): string {
  return path.join(homedir(), ".mcode", "skill-market");
}

export function globalSkillsRoot(): string {
  return path.join(homedir(), ".mcode", "skills");
}

function treeDirFor(id: string): string {
  return path.join(marketRoot(), id);
}

/** Separator-aware containment (same semantics as ipc/skills.ts pathWithin). */
export function pathWithin(root: string, abs: string): boolean {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  if (a === r) return true;
  return a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/* ── Settings (the only DB touch points) ── */

async function readRecords(): Promise<SkillMarketRecord[]> {
  await awaitDb();
  const raw = SettingRepo.get(SKILL_MARKET_SOURCES_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is SkillMarketRecord =>
        typeof r === "object" && r !== null &&
        typeof (r as SkillMarketRecord).id === "string" &&
        MARKET_ID_RE.test((r as SkillMarketRecord).id) &&
        typeof (r as SkillMarketRecord).name === "string" &&
        typeof (r as SkillMarketRecord).url === "string" &&
        typeof (r as SkillMarketRecord).addedAt === "string",
    );
  } catch {
    return [];
  }
}

async function writeRecords(records: SkillMarketRecord[]): Promise<void> {
  await awaitDb();
  SettingRepo.set(SKILL_MARKET_SOURCES_SETTING_KEY, JSON.stringify(records));
}

/* ── Source classification ── */

export type MarketSource =
  | { kind: "git"; url: string; normalized: string }
  | { kind: "local"; dir: string; normalized: string };

/** Classify + normalize a user-entered source. Throws on anything that isn't
 *  an https URL or an absolute local path (ssh:, file:, git@, relative …). */
export function classifySource(input: string): MarketSource {
  const raw = input.trim();
  if (/^https:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error("无效的 Git 地址");
    }
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) {
      throw new Error("无效的 Git 地址");
    }
    let p = u.pathname.replace(/\/+$/, "");
    if (p.toLowerCase().endsWith(".git")) p = p.slice(0, -4);
    p = p.replace(/\/+$/, "");
    if (!p || p === "/") throw new Error("无效的 Git 地址");
    const port = u.port ? `:${u.port}` : "";
    return { kind: "git", url: raw, normalized: `https://${u.hostname.toLowerCase()}${port}${p}` };
  }
  // Any other scheme (ssh:, file:, http:, git@host:…) is rejected. A Windows
  // drive path ("C:\…") is not a scheme: require the drive letter form.
  const isWinDrive = /^[A-Za-z]:[\\/]/.test(raw);
  if (!isWinDrive && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) {
    throw new Error("仅支持 https:// Git 地址或本地文件夹绝对路径");
  }
  if (!path.isAbsolute(raw)) {
    throw new Error("仅支持 https:// Git 地址或本地文件夹绝对路径");
  }
  const dir = path.resolve(raw);
  const norm = process.platform === "win32" ? dir.toLowerCase() : dir;
  return { kind: "local", dir, normalized: norm.replace(/[\\/]+$/, "") };
}

/** Stable id: slug of the last path segment + short hash of the normalized source. */
export function marketIdFor(src: MarketSource): string {
  const last = src.normalized.split(/[\\/]/).filter(Boolean).pop() ?? "market";
  const slug = last.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "market";
  const hash = createHash("sha1").update(src.normalized).digest("hex").slice(0, 6);
  return `${slug}-${hash}`;
}

/* ── Scan ── */

/** Walk `treeDir` (depth ≤ 4, skipping .git / node_modules / dot-dirs and
 *  symlinks) and return every directory that contains SKILL.md. A skill dir is
 *  not descended into. Names come from frontmatter `name` when it's a valid
 *  skill name, else the directory name; entries with neither are skipped.
 *  Duplicate names: first found wins. Sorted by name. Never throws. */
export async function scanMarketTree(
  treeDir: string,
  marketId: string,
  skillsRoot: string,
): Promise<SkillMarketEntry[]> {
  const byName = new Map<string, SkillMarketEntry>();

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const child = path.join(dir, e.name);
      const md = await readTextHead(path.join(child, "SKILL.md"));
      if (md != null) {
        const fm = parseSkillFrontmatter(md);
        const fmName = fm.name?.trim() ?? "";
        const name = SKILL_NAME_RE.test(fmName) ? fmName : SKILL_NAME_RE.test(e.name) ? e.name : "";
        if (!name || byName.has(name)) continue;
        let description = (fm.description ?? "").trim();
        if (description.length > DESCRIPTION_MAX) description = `${description.slice(0, DESCRIPTION_MAX)}…`;
        byName.set(name, {
          marketId,
          name,
          description,
          relPath: path.relative(treeDir, child).split(path.sep).join("/"),
          installed: await exists(path.join(skillsRoot, name)),
        });
        continue; // don't descend into a skill
      }
      if (depth < SCAN_MAX_DEPTH) await walk(child, depth + 1);
    }
  };

  await walk(treeDir, 1);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ── Install ── */

/** Copy `<treeDir>/<relPath>` into `<skillsRoot>/<name>`. Throws with a
 *  user-readable message on any guard failure. Nested `.git` dirs are not copied. */
export async function installSkillFromTree(
  treeDir: string,
  relPath: string,
  name: string,
  skillsRoot: string,
): Promise<void> {
  if (!SKILL_NAME_RE.test(name)) throw new Error("无效的技能名");
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) throw new Error("无效的技能路径");
  const tree = path.resolve(treeDir);
  const src = path.resolve(tree, relPath);
  if (!pathWithin(tree, src) || src === tree) throw new Error("无效的技能路径");
  try {
    const st = await fs.stat(path.join(src, "SKILL.md"));
    if (!st.isFile()) throw new Error("x");
  } catch {
    throw new Error("技能目录中没有 SKILL.md");
  }
  const root = path.resolve(skillsRoot);
  const dest = path.join(root, name);
  if (!pathWithin(root, dest) || dest === root) throw new Error("无效的技能名");
  if (await exists(dest)) throw new Error("已存在同名技能");
  await fs.mkdir(root, { recursive: true });
  await fs.cp(src, dest, {
    recursive: true,
    filter: (p) => path.basename(p) !== ".git",
  });
}

/* ── Materialize (fetch) ── */

/** Fetch `src` into `dest` (must not exist): git shallow clone minus `.git`,
 *  or a recursive copy of a local directory minus `.git`. */
export async function materializeSource(src: MarketSource, dest: string): Promise<void> {
  if (src.kind === "git") {
    await gitClone(src.url, dest);
    await fs.rm(path.join(dest, ".git"), { recursive: true, force: true });
  } else {
    let st;
    try {
      st = await fs.stat(src.dir);
    } catch {
      throw new Error("本地文件夹不存在");
    }
    if (!st.isDirectory()) throw new Error("本地路径不是文件夹");
    if (pathWithin(marketRoot(), src.dir) || pathWithin(src.dir, marketRoot())) {
      throw new Error("不能使用技能市场自身的目录作为来源");
    }
    await fs.cp(src.dir, dest, {
      recursive: true,
      filter: (p) => path.basename(p) !== ".git",
    });
  }
  // Stamp the tree so its mtime reflects the fetch time (fetchedAt).
  const now = new Date();
  await fs.utimes(dest, now, now);
}

function stagingDir(): string {
  return path.join(marketRoot(), `.staging-${randomBytes(6).toString("hex")}`);
}

/** Materialize into staging and scan; on success returns the staging path
 *  (caller moves it), on failure cleans staging and rethrows. */
async function stageAndScan(src: MarketSource): Promise<string> {
  await fs.mkdir(marketRoot(), { recursive: true });
  const staging = stagingDir();
  try {
    await materializeSource(src, staging);
    const found = await scanMarketTree(staging, "staging", globalSkillsRoot());
    if (found.length === 0) throw new Error("没有找到任何 SKILL.md");
    return staging;
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/* ── Public API (IPC) ── */

const lastErrors = new Map<string, string>();
const busy = new Set<string>();

interface MarketDef {
  id: string;
  name: string;
  url: string;
  builtin: boolean;
}

async function allMarkets(): Promise<MarketDef[]> {
  const builtins: MarketDef[] = BUILTIN_SKILL_MARKETS.map((m) => ({ ...m, builtin: true }));
  const builtinIds = new Set(builtins.map((m) => m.id));
  const user = (await readRecords())
    .filter((r) => !builtinIds.has(r.id))
    .map((r) => ({ id: r.id, name: r.name, url: r.url, builtin: false }));
  return [...builtins, ...user];
}

export async function listMarkets(): Promise<SkillMarketState[]> {
  const skillsRoot = globalSkillsRoot();
  const out: SkillMarketState[] = [];
  for (const m of await allMarkets()) {
    const tree = treeDirFor(m.id);
    let fetchedAt: string | null = null;
    let skills: SkillMarketEntry[] = [];
    try {
      const st = await fs.stat(tree);
      if (st.isDirectory()) {
        fetchedAt = st.mtime.toISOString();
        skills = await scanMarketTree(tree, m.id, skillsRoot);
      }
    } catch {
      // not fetched yet
    }
    out.push({ ...m, fetchedAt, error: lastErrors.get(m.id) ?? null, skills });
  }
  return out;
}

export async function addMarket(url: string, name?: string): Promise<void> {
  const src = classifySource(url);
  const markets = await allMarkets();
  for (const m of markets) {
    let norm: string;
    try {
      norm = classifySource(m.url).normalized;
    } catch {
      continue;
    }
    if (norm === src.normalized) throw new Error("该来源已添加");
  }
  const id = marketIdFor(src);
  if (markets.some((m) => m.id === id) || busy.has(id)) throw new Error("该来源已添加");
  busy.add(id);
  try {
    const staging = await stageAndScan(src);
    const final = treeDirFor(id);
    await fs.rm(final, { recursive: true, force: true });
    await fs.rename(staging, final);
    const displayName =
      name?.trim() ||
      (src.kind === "git"
        ? src.normalized.replace(/^https:\/\/[^/]+\//, "")
        : path.basename(src.dir) || src.dir);
    const records = await readRecords();
    records.push({ id, name: displayName.slice(0, 80), url: url.trim(), addedAt: new Date().toISOString() });
    await writeRecords(records);
    lastErrors.delete(id);
    log.info(`skillMarket: added ${id} (${src.kind})`);
  } finally {
    busy.delete(id);
  }
}

export async function refreshMarket(id: string): Promise<void> {
  const m = (await allMarkets()).find((x) => x.id === id);
  if (!m) throw new Error("未知的技能市场");
  if (busy.has(id)) throw new Error("正在拉取中");
  busy.add(id);
  try {
    const staging = await stageAndScan(classifySource(m.url));
    const final = treeDirFor(id);
    await fs.rm(final, { recursive: true, force: true });
    await fs.rename(staging, final);
    lastErrors.delete(id);
    log.info(`skillMarket: refreshed ${id}`);
  } catch (err) {
    const msg = (err as Error).message;
    lastErrors.set(id, msg);
    log.warn(`skillMarket: refresh ${id} failed: ${msg}`);
    throw err;
  } finally {
    busy.delete(id);
  }
}

export async function removeMarket(id: string): Promise<void> {
  if (BUILTIN_SKILL_MARKETS.some((m) => m.id === id)) throw new Error("内置技能市场不能移除");
  const records = await readRecords();
  const next = records.filter((r) => r.id !== id);
  if (next.length === records.length) throw new Error("未知的技能市场");
  await writeRecords(next);
  lastErrors.delete(id);
  if (MARKET_ID_RE.test(id)) {
    await fs.rm(treeDirFor(id), { recursive: true, force: true });
  }
}

export async function installFromMarket(marketId: string, relPath: string, name: string): Promise<void> {
  if (!MARKET_ID_RE.test(marketId)) throw new Error("未知的技能市场");
  const known = (await allMarkets()).some((m) => m.id === marketId);
  if (!known) throw new Error("未知的技能市场");
  const tree = treeDirFor(marketId);
  if (!(await exists(tree))) throw new Error("技能市场尚未拉取");
  await installSkillFromTree(tree, relPath, name, globalSkillsRoot());
  log.info(`skillMarket: installed ${name} from ${marketId}/${relPath}`);
}
